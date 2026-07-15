import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../../db/types.js";

import { parseProvenanceEpisodeIds } from "./search-semantic.js";
import { DEFAULT_SEARCH_LIMIT, type SearchHit } from "./types.js";

/**
 * Graph traversal via recursive CTE over kg_nodes/kg_edges (§5.2).
 *
 * Starts from nodes matching entity names (canonical_name / aliases), walks
 * up to `maxHops` edges that are currently valid, and ranks by hop distance.
 */
export async function searchGraph(
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
