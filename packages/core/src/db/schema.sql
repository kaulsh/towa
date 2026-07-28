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
  chat_id TEXT NULL,
  message_id TEXT NULL,
  media_file_id TEXT NULL,
  media_mime_type TEXT NULL,
  media_kind TEXT NULL CHECK (
    media_kind IS NULL
    OR media_kind IN ('image', 'audio', 'video', 'file')
  ),
  media_file_name TEXT NULL,
  is_media_artifact INTEGER NOT NULL DEFAULT 0 CHECK (is_media_artifact IN (0, 1)),
  edit_of INTEGER NULL REFERENCES raw_log(id),
  deleted_marker INTEGER NOT NULL DEFAULT 0 CHECK (deleted_marker IN (0, 1))
);

CREATE INDEX raw_log_chat_message
  ON raw_log (chat_id, message_id)
  WHERE edit_of IS NULL AND deleted_marker = 0;

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

-- Adaptive /init interview state (keyed by chat_id). Goal lists are JSON arrays.
CREATE TABLE init_interview (
  chat_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('idle', 'active', 'completed')),
  turn_count INTEGER NOT NULL DEFAULT 0,
  resolved_goals TEXT NOT NULL DEFAULT '[]', -- JSON array of goal ids
  pending_goals TEXT NOT NULL DEFAULT '[]',  -- JSON array of goal ids
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
