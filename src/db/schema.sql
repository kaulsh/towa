-- Towa canonical schema (design doc §2, §3, §10).
-- Applied via ordered migrations in src/db/migrations/; this file is the
-- reference snapshot, not run directly at startup.
--
-- Invariant: kg_edges.valid_to NEVER uses NULL. Open edges use the far-future
-- sentinel VALID_TO_OPEN_SENTINEL = 253370764800 (unix seconds for
-- 9999-01-01T00:00:00Z). Every temporal query is uniform:
--   valid_from <= :now AND :now < valid_to

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE raw_log (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  source_meta TEXT NOT NULL, -- JSON
  edit_of INTEGER NULL REFERENCES raw_log(id),
  deleted_marker INTEGER NOT NULL DEFAULT 0 CHECK (deleted_marker IN (0, 1))
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  start_msg_id INTEGER NOT NULL,
  end_msg_id INTEGER NOT NULL,
  closed_at INTEGER NOT NULL
);

CREATE TABLE kg_nodes (
  id TEXT PRIMARY KEY,
  type_label TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases TEXT NOT NULL, -- JSON array
  attributes TEXT NOT NULL, -- JSON
  embedding BLOB,
  provenance TEXT NOT NULL -- JSON array of raw_log / episode ids
);

CREATE TABLE kg_edges (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES kg_nodes(id),
  relation_label TEXT NOT NULL,
  object_id TEXT NULL REFERENCES kg_nodes(id),
  object_literal TEXT NULL,
  valid_from INTEGER NOT NULL,
  -- NEVER NULL: open edges use VALID_TO_OPEN_SENTINEL (253370764800)
  valid_to INTEGER NOT NULL DEFAULT 253370764800,
  ingested_at INTEGER NOT NULL,
  provenance TEXT NOT NULL -- JSON array of episode ids
);

CREATE TABLE episode_gists (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id),
  gist_text TEXT NOT NULL,
  embedding BLOB
);

CREATE TABLE pending_extraction (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done')),
  updated_at INTEGER NOT NULL
);

-- FTS5 over searchable text (raw log content + episode gists).
-- Track C populates/queries this; Phase 0 only ensures it exists.
CREATE VIRTUAL TABLE search_fts USING fts5(
  content,
  source_type UNINDEXED, -- 'raw_log' | 'gist'
  source_id UNINDEXED,   -- raw_log.id or episode_gists.episode_id as text
  tokenize = 'porter unicode61'
);
