# Track C — Retrieval & Context Assembly

## Goal

Implement the forced retrieval pipeline (query-gen → multi-signal search → RRF merge → context assembly → generation-doubles-as-gate loop) and the agent loop's context assembly (working-context buffer, session boundaries, token budgeting).

## Dependencies

**Phase 0 only.** This track consumes:
- The DB schema + Kysely instance from Phase 0 (`src/db/`) — queries against `raw_log`, `episodes`, `kg_nodes`, `kg_edges`, `episode_gists`.
- `src/models/types.ts` — the `LoadedChatModel`/`LoadedEmbeddingModel` **interfaces only**. You do not need Track A's concrete loader implementations to exist to build this — write against the interface and use a mock/stub `LoadedChatModel`/`LoadedEmbeddingModel` for your own tests. Integration with real loaders happens after all tracks merge.

Phase 0 must be merged to `main` before you branch. Do not wait on Track A, B, or D — none of them are dependencies of this track.

## Before you start

Read, in full:
- `CLAUDE.md` — in particular these invariants: "Retrieval is a forced pipeline, not an optional tool call" (§5.1), "Every episode gets a gist + embedding unconditionally" (§2.4, §6), "Token budgets are computed via `countTokens()`, never hardcoded" (§5, §6, §8.3), and "No separate relevance-judge LLM call" anti-pattern (the generation call doubles as the sufficiency gate).
- `docs/towa-design.md` §5 in full (Retrieval Architecture) and §6 in full (Agent Loop & Context Assembly). §5.1 explains *why* free-form agentic tool calls were rejected in favor of a forced pipeline — understand this before implementing, since it's the core design constraint on everything in this track.
- `src/db/` and `src/models/types.ts` as they exist on `main` post-Phase-0.

## What to build

### 1. Forced query-generation (§5.2 step 1)

Before answering, a required structured-output call: produce search queries + entity names from the message + recent context. This is a mandatory pipeline stage — not a tool the model can decline. Use Zod (§13) to define and validate the structured-output schema, with the prompt-based-JSON + parse + one-retry fallback when `capabilities.structuredOutput` is false (§8.1's structured-output fallback pattern — check the capability, don't assume).

### 2. Multi-signal search (§5.2 step 2)

Three complementary stores, queried in parallel:
- **Lexical (FTS5)** — exact tokens (names, numbers, rare words) that vector search's paraphrase-tolerance can miss.
- **Semantic (`sqlite-vec` over gists + KG nodes)** — paraphrase / "things like this," using the embedding model's `embed()`.
- **Graph (recursive CTE traversal over `kg_nodes`/`kg_edges`)** — structurally-related facts, multi-hop recall (e.g. "what's true about my sister") even when the current message never names the entity. Use Kysely's raw-fragment escape hatch for the CTE and `sqlite-vec` distance functions (§13) — this is exactly the case that motivated choosing Kysely over a full ORM.

### 3. RRF merge (§5.2 step 3)

Reciprocal Rank Fusion: sum `1/(k + rank)` per candidate across the three ranked lists. Pure arithmetic — no LLM call, no incomparable-score calibration (BM25 vs. cosine) needed.

### 4. Context assembly (§5.2 step 4, §6)

- Resolves RRF-ranked candidates to **verbatim raw turns** from the winning episodes (never summaries-in-place-of-source) plus current-valid KG facts.
- **Temporal-aware retrieval (§5.3):** default retrieval resolves only currently-true facts — `WHERE valid_from <= :now AND :now < valid_to` (uniform because `valid_to` never uses `NULL`, per the schema invariant). Implement a dedicated `get_history(entity, relation)` path for explicitly historical questions ("what did I used to think about X?"). Implicit past-tense detection in query-gen may *widen* retrieval to include history as a soft hint, but must never be the sole gate to the historical layer. When both current and historical facts land in context together, present them as **distinct labeled blocks** so the model doesn't blur "you used to" with "you do."
- **Working-context buffer (§6):** a sliding window of the most recent raw turns, token-budgeted (not count-budgeted) via the active chat model's own `countTokens()` — never a fixed global constant. `budget = capabilities.contextWindow − reservedForSystemPrompt − reservedForOutput`, split between working-context and retrieved-context by a configurable ratio (default: even split). When a turn ages out of the window, it is **dropped, not summarized** — no rolling-summary layer (this is safe because every episode is unconditionally gisted+embedded by Track D, so anything dropped remains findable via this same retrieval pipeline).
- **Session boundary (§6):** an idle gap beyond a threshold (e.g. >2 hours) resets the working-context buffer rather than sliding continuously.
- **Retrieved-context budget:** not a fixed token constant — it's whatever's left of the total per-turn budget after working-context and reserved output are subtracted, measured via `countTokens()`. Add RRF-ranked candidate episodes to context in rank order until that portion is exhausted.

### 5. Generation-doubles-as-gate loop (§5.2 step 5)

The same call that answers the user also declares sufficiency via structured output: either `{answer}` or `{insufficient: true, follow_up_queries: [...]}`. On insufficient, loop back to query-gen with the follow-up queries — **capped at a fixed K rounds (e.g. K=2–3), a hard bound, not model discretion**, so a stuck loop can't run away. Do not add a separate judge/relevance LLM call on top of this — that's an explicitly rejected anti-pattern (`CLAUDE.md`).

## Interface contract you must produce/consume

- **Consumes:** `LoadedChatModel`/`LoadedEmbeddingModel` from `src/models/types.ts` (Phase 0) — inject instances, don't import or depend on Track A's concrete loaders.
- **Consumes:** Phase 0's Kysely `Database` type/instance for all queries.
- **Produces:** whatever the harness-assembly step (post-merge integration, not part of this track) needs to call per turn — a single entry point along the lines of `runRetrievalAndGenerate(message, workingContext, chatModel, embeddingModel) → { answer } | GenerateOutput` is a reasonable shape, but you have latitude here since the design doc doesn't pin an exact function signature for this — just keep it a single clear entry point so integration is a one-line wire-up, not a re-read of this track's internals.

## File-level footprint

```
src/core/retrieval/**
src/core/context-assembly/**
package.json   (add zod if not already present from Phase 0 — it should be; don't duplicate)
```

Do not touch `src/db/`, `src/models/types.ts`, `src/channels/`, `src/core/kg/`, `src/core/gist/`, or `src/core/write-path/` (Phase 0/Track D-owned) — query the schema Phase 0 defined, don't redefine it.

## Definition of done

- Query-gen, multi-signal search (all three stores), RRF merge, context assembly, and the generation-gate loop are all implemented and typed.
- The gate loop is hard-capped at a fixed K rounds.
- Temporal queries default to current-valid-only (`valid_from <= now < valid_to`) with a separate `get_history` path for explicit historical queries; current vs. historical facts are presented as distinct labeled blocks when both appear.
- Working-context and retrieved-context budgets are both computed via `countTokens()` on the injected `LoadedChatModel`, never a hardcoded token count.
- No separate judge/relevance LLM call anywhere in this track — sufficiency comes only from the generation call's own structured output.
- Typechecks cleanly against Phase 0's schema and `src/models/types.ts` with no modifications to either.
