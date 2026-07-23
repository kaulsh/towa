import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../../db/types.js";

import type { FtsSourceType } from "./types.js";

/**
 * Upsert a raw_log row into search_fts (Phase 0 created the table; Track C owns populate).
 * FTS5 has no native UPSERT by source_id — delete-then-insert.
 */
export async function indexRawLogForFts(
  db: Kysely<Database>,
  rawLogId: number,
  content: string,
): Promise<void> {
  await deleteFtsBySource(db, "raw_log", String(rawLogId));
  await db
    .insertInto("search_fts")
    .values({
      content,
      source_type: "raw_log",
      source_id: String(rawLogId),
    })
    .execute();
}

/** Upsert an episode gist into search_fts. */
export async function indexGistForFts(
  db: Kysely<Database>,
  episodeId: number,
  gistText: string,
): Promise<void> {
  await deleteFtsBySource(db, "gist", String(episodeId));
  await db
    .insertInto("search_fts")
    .values({
      content: gistText,
      source_type: "gist",
      source_id: String(episodeId),
    })
    .execute();
}

export async function deleteFtsBySource(
  db: Kysely<Database>,
  sourceType: FtsSourceType,
  sourceId: string,
): Promise<void> {
  // FTS5 virtual tables: delete via rowid lookup on UNINDEXED columns.
  await sql`
    DELETE FROM search_fts
    WHERE source_type = ${sourceType}
      AND source_id = ${sourceId}
  `.execute(db);
}

/**
 * Escape FTS5 MATCH query tokens so user text doesn't break the query parser.
 * Wrap each whitespace-separated token in quotes; drop empty tokens.
 */
export function escapeFtsQuery(query: string): string {
  const tokens = query
    .replace(/["']/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return '""';
  }
  return tokens.map((t) => `"${t}"`).join(" ");
}
