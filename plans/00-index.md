# Towa Implementation Plan — Index

Source: `docs/towa-design.md`.

## Completed (on `main`)

| Order | File | Goal | Depends on |
|---|---|---|---|
| 0 | [`00-foundation.md`](./00-foundation.md) | Project skeleton, SQLite schema/migrations, model + channel interface types | — |
| A | [`track-a-model-providers.md`](./track-a-model-providers.md) | Loader factories + context-window registry + token counting | Phase 0 |
| B | [`track-b-channel-layer.md`](./track-b-channel-layer.md) | `TelegramAdapter` (Telegraf) | Phase 0 |
| C | [`track-c-retrieval-context.md`](./track-c-retrieval-context.md) | Forced retrieval + context assembly | Phase 0 |
| D | [`track-d-write-path-kg.md`](./track-d-write-path-kg.md) | Async extraction drain / KG / gists / media enrich-in-memory | Phase 0 |
| E | [`track-e-harness.md`](./track-e-harness.md) | `createHarness` agent loop; slim example | A–D merged |

## Next (this wave)

| Order | File | Goal | Depends on | Parallel? |
|---|---|---|---|---|
| F | [`track-f-durable-media-text.md`](./track-f-durable-media-text.md) | Persist media transcripts/captions via append-only edits + edit-aware reads (§7.3) | Current `main` | Yes — with G |
| G | [`track-g-evals-harness.md`](./track-g-evals-harness.md) | promptfoo + gold sets (§9.1); LongMemEval scaffold (§9.2) | Current `main` | Yes — with F |
| H | [`track-h-query-time-media.md`](./track-h-query-time-media.md) | Best-effort query-time `fetchMedia` when durable caption insufficient (§7.3) | **F merged** | After F (parallel with G OK once F lands) |

## Run order

1. **F and G in parallel** (no Phase 0 — foundation already on `main`).
2. **H after F** (needs durable text + edit-aware reads). H does not need G.

## Scope notes

- No track in this plan is assigned to the planning session — all are handed to external coding agents.
- Track G’s plan includes a long **Approach** section for human review of the eval method before/while implementing.
- Query-time media was explicitly pulled into Track H (not deferred forever).

## Coordination points

1. Media durability = `appendRawLogEdit` + edit-aware reads — never `UPDATE` `raw_log` (Track F).
2. Evals do not wait on media write-back; fixtures seed `content` directly (Track G).
3. If a design question is unanswered, flag it — don’t invent schema (`CLAUDE.md`).
