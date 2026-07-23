# Track H — Query-time media fetch (best-effort)

## Goal

Implement the optional §7.3 path: at **query/retrieval time**, if a retrieved episode’s durable caption/transcript is insufficient for the user’s question and the platform `MediaRef` may still be live, best-effort `fetchMedia` + capability-gated multimodal describe — without treating binaries as durable memory.

## Dependencies

**Track F must be merged first.** This track assumes:

- Extraction persists media text via `appendRawLogEdit`.
- Verbatim loaders are edit-aware (resolved transcripts appear in assembled episodes).

May run in parallel with Track G after F lands; does not depend on evals.

## Before you start

Read:

- `CLAUDE.md` — media ephemeral; check `capabilities.audioInput` / `vision` before multimodal calls; token budgets via `countTokens()`.
- `docs/towa-design.md` §7.3 last bullet (on-demand fetch is optional, best-effort, not the durable guarantee).
- Track F plan: `plans/track-f-durable-media-text.md`.
- `src/core/retrieval/assemble.ts`, `src/core/kg/media.ts` (reuse describe helpers if exported cleanly).

## What to build

1. **Trigger (keep narrow — no speculative hooks):** After (or during) context assembly, when an assembled episode turn still has a `MediaRef` in `source_meta` and the resolved text is only a degrade placeholder (or empty) **or** query-gen/gate signals need more media detail — prefer a **simple, explicit heuristic** documented in code, e.g.:
   - Resolved content matches “no content extracted” / capability-missing placeholders from `media.ts`, and
   - The active chat model has the relevant capability.
2. Call `adapter.fetchMedia` + existing describe path (factor shared helpers from `media.ts` if needed so extraction and query-time don’t diverge).
3. **Do not** require persisting query-time refreshes unless the new text is clearly better and you reuse Track F’s append-edit path — if you persist, use the same append-only rules; if you only inject into the in-memory assembled context for this turn, say so in the review guide.
4. Failures (expired Telegram file, network, missing capability) → leave existing durable text; never fail the whole reply.

## Out of scope

- Making binaries durable.
- Video/file full multimodal if still deferred in `media.ts` (match extraction v1 behavior unless you deliberately extend both paths together — prefer consistency).

## Interface contract

| Produce | Consume |
|---|---|
| Best-effort enrich in assemble/retrieval path | `ChannelAdapter.fetchMedia`, Track F resolve helpers, `LoadedChatModel` capabilities |
| Optional append-edit if persisting refresh | `appendRawLogEdit` |

## File-level footprint

- `src/core/retrieval/assemble.ts` and/or a sibling `src/core/retrieval/media-refresh.ts`
- `src/core/kg/media.ts` (shared describe helpers)
- Possibly pipeline wiring to pass `adapter` + `chatModel` into assemble (today assemble may lack adapter — inject via `RunRetrievalAndGenerateInput` / assemble input; **harness already has adapter** — thread it through carefully)
- `src/core/harness/create-harness.ts` / `pipeline.ts` only as needed to pass `adapter`

**Do not touch:** `evals/**` (Track G).

## Definition of done

- [ ] With a live `MediaRef` and a turn whose durable text is a placeholder, retrieval/assembly can best-effort refresh description when capabilities allow.
- [ ] Expired/failed fetch does not break the turn.
- [ ] Durable guarantee remains the Track F artifact; this path is clearly best-effort in comments + review guide.
- [ ] `pnpm build` + `pnpm typecheck` pass.
- [ ] Code-flow review guide: entry at assemble/pipeline → decide refresh → fetchMedia → describe → merge into context (± persist).

## Coordination

- After F; independent of G.
