import type { Kysely } from "kysely";

import { sql } from "kysely";

import type { LoadedEmbeddingModel } from "../ai/types.js";
import type { Database } from "../db/types.js";

import { escapeFtsQuery } from "./fts-index.js";
import {
  DEFAULT_SEARCH_LIMIT,
  RRF_K,
  type QueryGenResult,
  type RrfScoredEpisode,
  type SearchHit,
} from "./types.js";

export interface MultiSignalSearchOptions {
  nowSec?: number;
  limit?: number;
}

/**
 * Run lexical, semantic, and graph searches in parallel, then RRF-merge (§5.2).
 */
export async function multiSignalSearch(
  db: Kysely<Database>,
  embeddingModel: LoadedEmbeddingModel,
  queryGen: QueryGenResult,
  options: MultiSignalSearchOptions = {},
): Promise<{ ranked: RrfScoredEpisode[] }> {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);

  const [lexical, semantic, graph] = await Promise.all([
    searchLexical(db, queryGen.searchQueries, limit),
    searchSemantic(db, embeddingModel, queryGen.searchQueries, limit),
    searchGraph(db, queryGen.entityNames, { nowSec, limit }),
  ]);

  const ranked = mergeRrf([lexical, semantic, graph]);
  return { ranked };
}

/**
 * Reciprocal Rank Fusion (§5.2 step 3).
 *
 * score(episode) = Σ 1/(k + rank) across ranked lists.
 * Pure arithmetic — no score calibration between BM25 and cosine.
 */
function mergeRrf(lists: readonly (readonly SearchHit[])[], k: number = RRF_K): RrfScoredEpisode[] {
  const scores = new Map<number, { score: number; edgeIds: Set<string> }>();

  for (const list of lists) {
    for (const hit of list) {
      const contrib = 1 / (k + hit.rank);
      let entry = scores.get(hit.episodeId);
      if (!entry) {
        entry = { score: 0, edgeIds: new Set() };
        scores.set(hit.episodeId, entry);
      }
      entry.score += contrib;
      for (const edgeId of hit.edgeIds ?? []) {
        entry.edgeIds.add(edgeId);
      }
    }
  }

  return [...scores.entries()]
    .map(([episodeId, { score, edgeIds }]) => ({
      episodeId,
      score,
      edgeIds: [...edgeIds],
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Lexical (FTS5) search over raw_log content + episode gists (§5.2).
 * Returns ranked episode ids (1-based position within fused per-query results).
 */
async function searchLexical(
  db: Kysely<Database>,
  queries: readonly string[],
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SearchHit[]> {
  const episodeRanks = new Map<number, number>();

  for (const query of queries) {
    const match = escapeFtsQuery(query);
    if (match === '""') {
      continue;
    }

    const rows = await sql<{
      source_type: string;
      source_id: string;
    }>`
      SELECT source_type, source_id
      FROM search_fts
      WHERE search_fts MATCH ${match}
      ORDER BY rank
      LIMIT ${sql.lit(limit)}
    `.execute(db);

    let position = 0;
    for (const row of rows.rows) {
      const episodeId = await resolveEpisodeId(db, row.source_type, row.source_id);
      if (episodeId === null) {
        continue;
      }
      position += 1;
      const prev = episodeRanks.get(episodeId);
      if (prev === undefined || position < prev) {
        episodeRanks.set(episodeId, position);
      }
    }
  }

  return [...episodeRanks.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([episodeId, rank]) => ({ episodeId, rank }));
}

async function resolveEpisodeId(
  db: Kysely<Database>,
  sourceType: string,
  sourceId: string,
): Promise<number | null> {
  if (sourceType === "gist") {
    const id = Number(sourceId);
    return Number.isFinite(id) ? id : null;
  }

  if (sourceType === "raw_log") {
    const msgId = Number(sourceId);
    if (!Number.isFinite(msgId)) {
      return null;
    }
    const ep = await db
      .selectFrom("episodes")
      .select("id")
      .where("start_msg_id", "<=", msgId)
      .where("end_msg_id", ">=", msgId)
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return ep?.id ?? null;
  }

  return null;
}

/**
 * Semantic search via sqlite-vec over episode gists + KG node embeddings (§5.2).
 *
 * Embeddings live as BLOBs on regular tables (Phase 0 schema); we use
 * `vec_distance_cosine` for brute-force KNN — appropriate at single-user scale.
 */
async function searchSemantic(
  db: Kysely<Database>,
  embeddingModel: LoadedEmbeddingModel,
  queries: readonly string[],
  limit: number = DEFAULT_SEARCH_LIMIT,
): Promise<SearchHit[]> {
  if (queries.length === 0) {
    return [];
  }

  const vectors = await embeddingModel.embed([...queries]);
  const episodeRanks = new Map<number, number>();

  for (const vector of vectors) {
    if (!vector || vector.length === 0) {
      continue;
    }
    const blob = float32Buffer(vector);

    const gistHits = await sql<{ episode_id: number; distance: number }>`
      SELECT episode_id, vec_distance_cosine(embedding, ${blob}) AS distance
      FROM episode_gists
      WHERE embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${sql.lit(limit)}
    `.execute(db);

    let position = 0;
    for (const row of gistHits.rows) {
      position += 1;
      const prev = episodeRanks.get(row.episode_id);
      if (prev === undefined || position < prev) {
        episodeRanks.set(row.episode_id, position);
      }
    }

    const nodeHits = await sql<{
      id: string;
      distance: number;
      provenance: string;
    }>`
      SELECT id, provenance, vec_distance_cosine(embedding, ${blob}) AS distance
      FROM kg_nodes
      WHERE embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${sql.lit(limit)}
    `.execute(db);

    let nodePosition = 0;
    for (const row of nodeHits.rows) {
      nodePosition += 1;
      const episodeIds = parseProvenanceEpisodeIds(row.provenance);
      for (const episodeId of episodeIds) {
        const prev = episodeRanks.get(episodeId);
        if (prev === undefined || nodePosition < prev) {
          episodeRanks.set(episodeId, nodePosition);
        }
      }
    }
  }

  return [...episodeRanks.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([episodeId, rank]) => ({ episodeId, rank }));
}

function float32Buffer(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Provenance is a JSON array of raw_log / episode ids (§2.3).
 * Prefer numeric episode-looking ids; accept numbers and
 * `{episode_id:n}` / `{episodeId:n}` objects.
 */
function parseProvenanceEpisodeIds(provenanceJson: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(provenanceJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const ids: number[] = [];
  for (const item of parsed) {
    if (typeof item === "number" && Number.isFinite(item)) {
      ids.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const ep = obj.episode_id ?? obj.episodeId;
      if (typeof ep === "number" && Number.isFinite(ep)) {
        ids.push(ep);
      }
    }
  }
  return [...new Set(ids)];
}

/**
 * Graph traversal via recursive CTE over kg_nodes/kg_edges (§5.2).
 *
 * Starts from nodes matching entity names (canonical_name / aliases), walks
 * up to `maxHops` edges that are currently valid, and ranks by hop distance.
 */
async function searchGraph(
  db: Kysely<Database>,
  entityNames: readonly string[],
  options: {
    nowSec?: number;
    maxHops?: number;
    limit?: number;
  } = {},
): Promise<SearchHit[]> {
  if (entityNames.length === 0) {
    return [];
  }

  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const maxHops = options.maxHops ?? 3;
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;

  const seedNodeIds = await resolveEntityNodeIds(db, entityNames);
  if (seedNodeIds.length === 0) {
    return [];
  }

  // Recursive CTE: expand along currently-valid edges in either direction.
  const rows = await sql<{
    edge_id: string;
    hop: number;
    provenance: string;
  }>`
    WITH RECURSIVE
    seeds(node_id) AS (
      SELECT value AS node_id
      FROM json_each(${JSON.stringify(seedNodeIds)})
    ),
    walk(edge_id, node_id, hop, provenance) AS (
      SELECT e.id, e.object_id, 1, e.provenance
      FROM kg_edges e
      JOIN seeds s ON e.subject_id = s.node_id
      WHERE e.valid_from <= ${nowSec} AND ${nowSec} < e.valid_to
        AND e.object_id IS NOT NULL

      UNION

      SELECT e.id, e.subject_id, 1, e.provenance
      FROM kg_edges e
      JOIN seeds s ON e.object_id = s.node_id
      WHERE e.valid_from <= ${nowSec} AND ${nowSec} < e.valid_to

      UNION

      SELECT e.id, e.object_id, w.hop + 1, e.provenance
      FROM walk w
      JOIN kg_edges e ON e.subject_id = w.node_id
      WHERE w.hop < ${sql.lit(maxHops)}
        AND e.valid_from <= ${nowSec} AND ${nowSec} < e.valid_to
        AND e.object_id IS NOT NULL

      UNION

      SELECT e.id, e.subject_id, w.hop + 1, e.provenance
      FROM walk w
      JOIN kg_edges e ON e.object_id = w.node_id
      WHERE w.hop < ${sql.lit(maxHops)}
        AND e.valid_from <= ${nowSec} AND ${nowSec} < e.valid_to
    )
    SELECT DISTINCT edge_id, hop, provenance
    FROM walk
    ORDER BY hop ASC
    LIMIT ${sql.lit(limit * 4)}
  `.execute(db);

  // Also include literal-object edges from seed nodes (no further hop).
  const literalEdges = await sql<{
    edge_id: string;
    provenance: string;
  }>`
    SELECT e.id AS edge_id, e.provenance
    FROM kg_edges e
    WHERE e.subject_id IN (SELECT value FROM json_each(${JSON.stringify(seedNodeIds)}))
      AND e.object_id IS NULL
      AND e.valid_from <= ${nowSec} AND ${nowSec} < e.valid_to
    LIMIT ${sql.lit(limit)}
  `.execute(db);

  const episodeRanks = new Map<number, { rank: number; edgeIds: Set<string> }>();

  const consider = (edgeId: string, provenance: string, hop: number) => {
    const episodeIds = parseProvenanceEpisodeIds(provenance);
    for (const episodeId of episodeIds) {
      const existing = episodeRanks.get(episodeId);
      if (!existing) {
        episodeRanks.set(episodeId, { rank: hop, edgeIds: new Set([edgeId]) });
      } else {
        existing.edgeIds.add(edgeId);
        if (hop < existing.rank) {
          existing.rank = hop;
        }
      }
    }
  };

  for (const row of rows.rows) {
    consider(row.edge_id, row.provenance, row.hop);
  }
  for (const row of literalEdges.rows) {
    consider(row.edge_id, row.provenance, 1);
  }

  return [...episodeRanks.entries()]
    .sort((a, b) => a[1].rank - b[1].rank)
    .slice(0, limit)
    .map(([episodeId, { rank, edgeIds }]) => ({
      episodeId,
      rank,
      ...(edgeIds.size > 0 ? { edgeIds: [...edgeIds] } : {}),
    }));
}

async function resolveEntityNodeIds(
  db: Kysely<Database>,
  entityNames: readonly string[],
): Promise<string[]> {
  const ids = new Set<string>();

  for (const name of entityNames) {
    const trimmed = name.trim();
    if (!trimmed) {
      continue;
    }

    const byCanonical = await db
      .selectFrom("kg_nodes")
      .select("id")
      .where("canonical_name", "=", trimmed)
      .execute();
    for (const row of byCanonical) {
      ids.add(row.id);
    }

    // Alias match: aliases is a JSON array of strings.
    const byAlias = await sql<{ id: string }>`
      SELECT id FROM kg_nodes
      WHERE EXISTS (
        SELECT 1 FROM json_each(aliases) AS a
        WHERE a.value = ${trimmed}
      )
    `.execute(db);
    for (const row of byAlias.rows) {
      ids.add(row.id);
    }
  }

  return [...ids];
}
