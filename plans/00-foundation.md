# Phase 0 — Foundation (sequential, must land on `main` before any parallel track starts)

## Goal

Bootstrap the project skeleton, the SQLite schema/migrations, and the two stable interface contracts (`LoadedChatModel`/`LoadedEmbeddingModel`, `ChannelAdapter`) that every parallel track (A–D) builds against. This is the only track in this plan that is sequential — everything downstream references it by section number, so it must be complete and merged before Tracks A, B, C, D branch off.

## Before you start

Read, in full:
- `CLAUDE.md` at the repo root — non-negotiable invariants and code patterns. In particular: raw log is append-only (never `UPDATE`/`DELETE`), `valid_to` always uses a far-future sentinel (never `NULL`), model interfaces stay segregated, loader-factory pattern, `ChannelAdapter` pattern.
- `docs/towa-design.md` §1 (Philosophy), §2 (Data Model), §3 (Storage Substrate), §7.1 (Channel interface), §8.1 (Model interfaces), §10 (Ops & Durability), §12 (Suggested Repo Layout), §13 (Frameworks & Libraries).

## What to build

### 1. Project skeleton
- `package.json`: add dependencies `kysely`, `better-sqlite3`, `sqlite-vec`, `telegraf`, `zod`, `pino` (plus `@types/better-sqlite3` and `typescript` as dev deps). The project uses `pnpm` (see existing `packageManager` field — don't change it).
- `tsconfig.json`: TypeScript strict mode (per `CLAUDE.md` §Style).
- Add a real `build`/`typecheck` script to `package.json` (e.g. `tsc --noEmit`), and update the "Build / lint / test commands are not yet set" note in `CLAUDE.md`'s Style section once you've added them — that note says explicitly to keep it current.
- Create the directory scaffold from design doc §12 under `src/` (empty dirs are fine where a later track owns the contents — see file-footprint list below for what Phase 0 itself populates).

### 2. SQLite schema + migrations (design doc §2, §3, §10)

Implement exactly the tables in §2.1–2.4 of the design doc (quoted below for convenience — treat the doc as authoritative if anything here drifts):

```
raw_log
  id              INTEGER PRIMARY KEY  -- monotonic
  timestamp       INTEGER              -- unix epoch, message time
  role            TEXT                 -- 'user' | 'assistant'
  content         TEXT                 -- verbatim text (or transcript/caption for media — see §7.3)
  source_meta     JSON                 -- platform message id, reply-to id, media ref, raw payload
  edit_of         INTEGER NULL         -- FK to raw_log.id if this row is an edit event
  deleted_marker  BOOLEAN DEFAULT FALSE

episodes
  id              INTEGER PRIMARY KEY
  start_msg_id    INTEGER
  end_msg_id      INTEGER
  closed_at       INTEGER

kg_nodes
  id              TEXT PRIMARY KEY     -- uuid
  type_label      TEXT                 -- free-form, e.g. "person", "project", "preference"
  canonical_name  TEXT
  aliases         JSON                 -- array of alternate names (populated by merges)
  attributes      JSON
  embedding       BLOB                 -- sqlite-vec vector, over canonical_name + attributes
  provenance      JSON                 -- array of raw_log / episode ids that support this node

kg_edges
  id              TEXT PRIMARY KEY
  subject_id      TEXT REFERENCES kg_nodes(id)
  relation_label  TEXT                 -- free-form, e.g. "lives_in", "sister_of"
  object_id       TEXT NULL REFERENCES kg_nodes(id)  -- NULL if object is a literal
  object_literal  TEXT NULL
  valid_from      INTEGER              -- world-time: when this became true
  valid_to        INTEGER              -- world-time: sentinel far-future value if still open
  ingested_at     INTEGER              -- transaction-time: when Towa learned this
  provenance      JSON                 -- episode id(s) that established/closed this edge

episode_gists
  episode_id      INTEGER REFERENCES episodes(id)
  gist_text       TEXT
  embedding       BLOB     -- sqlite-vec vector

pending_extraction
  episode_id      INTEGER PRIMARY KEY REFERENCES episodes(id)
  status          TEXT     -- 'pending' | 'in_progress' | 'done'
  updated_at      INTEGER

schema_version   -- §10: a version table + ordered migration scripts run on startup
```

Non-negotiable invariants to bake into the schema/migration layer itself (from `CLAUDE.md`):
- **`valid_to` never uses `NULL`** — pick and document the far-future sentinel (design doc suggests e.g. `9999-01-01` as unix epoch) and make sure any default/insert path enforces it.
- Set up **WAL mode** + `PRAGMA busy_timeout` on connection init (§3 table: "Concurrency").
- Load the `sqlite-vec` extension via `better-sqlite3`'s `loadExtension` (§3 table: "Driver").
- Create an **FTS5 virtual table** over the searchable text content (raw log content and/or episode gists — Track C will be the actual consumer, but the table needs to exist by the time Phase 0 lands).
- Migrations are hand-rolled ordered scripts run on startup against `schema_version` (§10) — no migration framework.

### 3. Kysely wiring
Set up a typed Kysely `Database` interface matching the schema above, instantiated over `better-sqlite3` (§13 table: "SQL query building"). This is what every other track imports to get a typed query builder — don't let any track hand-roll its own raw SQL string building where Kysely can express it (raw-fragment escape hatch is fine for `sqlite-vec` functions and recursive CTEs per §13).

### 4. Raw log writer (`src/core/raw-log/`)
Implement the append-only writer described in §2.1: insert a message row (sync, fast), append an edit row (`edit_of` FK, never mutate in place), append a delete-marker row. This is a synchronous, fast insert — no LLM calls, no async work.

### 5. Episode boundary derivation (`src/core/episodes/`)
Implement §2.2: episode = run of consecutive user messages since the last assistant message, plus the assistant reply that closes it. Recomputed from source, not persisted state, except for the `episodes` row itself which is written once the boundary closes (`closeEpisode()`).

### 6. Write-path queue helpers (`src/core/write-path/queue.ts`)
Thin helpers over `pending_extraction` only — `enqueuePendingExtraction(episodeId)` (insert with `status='pending'`), plus whatever read helpers Track D will need to poll for pending/in-progress rows. **Do not implement the drain loop or any extraction logic here** — that's Track D's `drain-worker.ts`. This file's job is just to make the queue table's contract (insert-on-close, poll-for-pending) available to both Track B (which enqueues on episode close) and Track D (which drains).

### 7. Model interface types (`src/models/types.ts`)
Copy verbatim from design doc §8.1 — this is already fully specified, no new design decision to make:

```typescript
interface LoadedChatModel {
  id: string;
  capabilities: {
    structuredOutput: boolean;
    vision: boolean;
    audioInput: boolean;
    contextWindow: number;
  };
  generate(input: GenerateInput): Promise<GenerateOutput>;
  countTokens(text: string): Promise<number>;
}

interface LoadedEmbeddingModel {
  id: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

You'll need to define `GenerateInput`/`GenerateOutput` shapes reasonably (the doc doesn't spell them out byte-for-byte) — keep them minimal: input needs at least messages/prompt + optional structured-output schema (Zod) + optional multimodal parts (for vision/audio per §7.3); output needs at least the generated text/structured payload. Track A (loaders) and Track C/D (consumers) both depend on this shape being stable, so keep it as close to the doc's stated fields as possible and don't over-design beyond what §5, §6, §7.3, §8 actually require of it.

### 8. Channel adapter types (`src/channels/adapter.ts`)
Copy verbatim from design doc §7.1 — interface only, no `TelegramAdapter` implementation (that's Track B):

```typescript
interface ChannelAdapter {
  start(): void;
  onMessage(handler: (msg: InboundMessage) => void): void;
  onEdit(handler: (edit: EditEvent) => void): void;
  onDelete(handler: (del: DeleteEvent) => void): void;
  onPresence?(handler: (p: PresenceEvent) => void): void;   // optional, widens debounce

  send(chatId: string, message: OutboundMessage): Promise<string>;  // returns platform message id
  fetchMedia(ref: MediaRef): Promise<{ data: Buffer; mimeType: string }>;
}

interface InboundMessage {
  chatId: string;
  role: 'user';
  content: string;
  timestamp: number;
  mediaRef?: MediaRef;
  raw: unknown;              // dumped straight into source_meta
}

type OutboundMessage =
  | { type: 'text'; text: string }
  | { type: 'image'; caption?: string; data: string; mimeType: string }  // base64
  | { type: 'video'; caption?: string; data: string; mimeType: string }  // base64
  | { type: 'audio'; caption?: string; data: string; mimeType: string }; // base64

interface MediaRef {
  platformFileId: string;
  mimeType: string;
  kind: 'image' | 'video' | 'audio' | 'file';
}
```

Also define `EditEvent`/`DeleteEvent`/`PresenceEvent` minimally — the doc references them but doesn't spell out fields; keep them minimal (platform message id + timestamp + whatever's needed to append the corresponding raw-log row per §2.1/§7.2).

## File-level footprint (Phase 0 owns these — no other track touches them)

```
package.json               (edit: deps + scripts)
tsconfig.json               (new)
CLAUDE.md                   (edit: fill in build/lint/test commands section)
src/db/schema.sql
src/db/migrations/**
src/db/kysely.ts            (or similar — typed Kysely instance + Database interface)
src/core/raw-log/**
src/core/episodes/**
src/core/write-path/queue.ts
src/models/types.ts
src/channels/adapter.ts
```

## Definition of done

- `pnpm install && pnpm typecheck` (or equivalent) passes cleanly on a fresh clone.
- A migration run creates all six tables listed above plus `schema_version`, with WAL mode and `sqlite-vec`/FTS5 loaded.
- `appendRawLogMessage`, `appendRawLogEdit`, `appendRawLogDelete`, `deriveEpisodeBoundary`/`closeEpisode`, `enqueuePendingExtraction` are implemented, typed, and exported from their respective modules.
- `LoadedChatModel`, `LoadedEmbeddingModel`, `ChannelAdapter`, `InboundMessage`, `OutboundMessage`, `MediaRef` types are exported and match the doc's shapes.
- No `UPDATE`/`DELETE` anywhere in the raw-log writer; no `NULL` `valid_to` path exists in the schema/migration layer.
- Merged to `main`. Confirm completion explicitly before Tracks A–D begin — they build against this code, not against the design doc directly, for anything schema/interface-shaped.
