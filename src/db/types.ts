import type { ColumnType, Generated } from "kysely";

/** SQLite stores booleans as 0/1 integers. */
export type SqliteBoolean = 0 | 1;

export type RawLogRole = "user" | "assistant";

export type ExtractionStatus = "pending" | "in_progress" | "done";

export type InitInterviewStatus = "idle" | "active" | "completed";

/**
 * JSON columns are stored as TEXT. Callers serialize/deserialize;
 * Kysely sees the on-disk string form.
 */
export interface RawLogTable {
  id: Generated<number>;
  timestamp: number;
  role: RawLogRole;
  content: string;
  source_meta: string;
  edit_of: number | null;
  deleted_marker: SqliteBoolean;
}

export interface EpisodesTable {
  id: Generated<number>;
  start_msg_id: number;
  end_msg_id: number;
  closed_at: number;
}

export interface KgNodesTable {
  id: string;
  type_label: string;
  canonical_name: string;
  aliases: string;
  attributes: string;
  embedding: Buffer | null;
  provenance: string;
}

export interface KgEdgesTable {
  id: string;
  subject_id: string;
  relation_label: string;
  object_id: string | null;
  object_literal: string | null;
  valid_from: number;
  /** Never NULL — open edges use VALID_TO_OPEN_SENTINEL. */
  valid_to: number;
  ingested_at: number;
  provenance: string;
}

export interface EpisodeGistsTable {
  episode_id: number;
  gist_text: string;
  embedding: Buffer | null;
}

export interface PendingExtractionTable {
  episode_id: number;
  status: ExtractionStatus;
  updated_at: number;
}

export interface SchemaVersionTable {
  version: number;
  applied_at: number;
}

/** Per-chat adaptive `/init` interview checklist (§6). */
export interface InitInterviewTable {
  chat_id: string;
  status: InitInterviewStatus;
  turn_count: number;
  /** JSON array of fact goal ids. */
  resolved_goals: string;
  /** JSON array of fact goal ids. */
  pending_goals: string;
  updated_at: number;
}

/**
 * FTS5 virtual table — not queried via typed Kysely inserts in Phase 0;
 * included so the Database interface documents every table that exists.
 * Track C owns populate/query. Use `sql` fragments for MATCH queries.
 */
export interface SearchFtsTable {
  content: string;
  source_type: ColumnType<string, string, never>;
  source_id: ColumnType<string, string, never>;
}

export interface Database {
  schema_version: SchemaVersionTable;
  raw_log: RawLogTable;
  episodes: EpisodesTable;
  kg_nodes: KgNodesTable;
  kg_edges: KgEdgesTable;
  episode_gists: EpisodeGistsTable;
  pending_extraction: PendingExtractionTable;
  init_interview: InitInterviewTable;
  search_fts: SearchFtsTable;
}
