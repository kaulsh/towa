import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../db/types.js";
import type { LoadedEmbeddingModel } from "../ai/types.js";

import { DEFAULT_SEARCH_LIMIT, type SearchHit } from "./types.js";

/**
 * Semantic search via sqlite-vec over episode gists + KG node embeddings (§5.2).
 *
 * Embeddings live as BLOBs on regular tables (Phase 0 schema); we use
 * `vec_distance_cosine` for brute-force KNN — appropriate at single-user scale.
 */
export async function searchSemantic(
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
 * Prefer numeric episode-looking ids; Track D owns the exact shape — we accept
 * numbers and `{episode_id:n}` / `{episodeId:n}` objects.
 */
export function parseProvenanceEpisodeIds(provenanceJson: string): number[] {
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
