import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../../db/types.js";

import { escapeFtsQuery } from "./fts-index.js";
import { DEFAULT_SEARCH_LIMIT, type SearchHit } from "./types.js";

/**
 * Lexical (FTS5) search over raw_log content + episode gists (§5.2).
 * Returns ranked episode ids (1-based position within fused per-query results).
 */
export async function searchLexical(
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
      const episodeId = await resolveEpisodeId(
        db,
        row.source_type,
        row.source_id,
      );
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
