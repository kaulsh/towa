import type { Kysely } from "kysely";
import { sql } from "kysely";

import { VALID_TO_OPEN_SENTINEL } from "../constants.js";
import type { Database } from "../types.js";

/**
 * Initial schema: raw_log, episodes, kg_nodes/edges, episode_gists,
 * pending_extraction, schema_version, and search_fts (FTS5).
 *
 * `valid_to` is NOT NULL with DEFAULT VALID_TO_OPEN_SENTINEL — no NULL path.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE raw_log (
      id INTEGER PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      source_meta TEXT NOT NULL,
      edit_of INTEGER NULL REFERENCES raw_log(id),
      deleted_marker INTEGER NOT NULL DEFAULT 0 CHECK (deleted_marker IN (0, 1))
    )
  `.execute(db);

  await sql`
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      start_msg_id INTEGER NOT NULL,
      end_msg_id INTEGER NOT NULL,
      closed_at INTEGER NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE kg_nodes (
      id TEXT PRIMARY KEY,
      type_label TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      aliases TEXT NOT NULL,
      attributes TEXT NOT NULL,
      embedding BLOB,
      provenance TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE kg_edges (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES kg_nodes(id),
      relation_label TEXT NOT NULL,
      object_id TEXT NULL REFERENCES kg_nodes(id),
      object_literal TEXT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER NOT NULL DEFAULT ${sql.lit(VALID_TO_OPEN_SENTINEL)},
      ingested_at INTEGER NOT NULL,
      provenance TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE episode_gists (
      episode_id INTEGER PRIMARY KEY REFERENCES episodes(id),
      gist_text TEXT NOT NULL,
      embedding BLOB
    )
  `.execute(db);

  await sql`
    CREATE TABLE pending_extraction (
      episode_id INTEGER PRIMARY KEY REFERENCES episodes(id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done')),
      updated_at INTEGER NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE VIRTUAL TABLE search_fts USING fts5(
      content,
      source_type UNINDEXED,
      source_id UNINDEXED,
      tokenize = 'porter unicode61'
    )
  `.execute(db);
}
