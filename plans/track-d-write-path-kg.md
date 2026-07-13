# Track D — Write Path & KG Extraction

## Goal

Implement the async extraction worker: the `pending_extraction` drain loop, entity resolution, bitemporal KG edge writes, and episode gist generation.

## Dependencies

**Phase 0 only.** This track consumes:
- The DB schema + Kysely instance from Phase 0 (`src/db/`) — reads `raw_log`/`episodes`, writes `kg_nodes`/`kg_edges`/`episode_gists`, reads/updates `pending_extraction` (via Phase 0's `src/core/write-path/queue.ts` read helpers).
- `src/models/types.ts` — the `LoadedChatModel`/`LoadedEmbeddingModel` **interfaces only**, same as Track C. Use a mock/stub for your own tests; real loaders come from Track A post-merge.
- `src/channels/adapter.ts` — the `ChannelAdapter` interface, specifically `fetchMedia(ref): Promise<{ data: Buffer; mimeType: string }>`. You call this method on whatever adapter instance is injected at runtime; you do not implement it (Track B does).

Phase 0 must be merged to `main` before you branch. Do not wait on Track A, B, or C — none of them are dependencies of this track.

## Before you start

Read, in full:
- `CLAUDE.md` — in particular these invariants: "No LLM call runs inside an open SQLite write transaction" (§4.2 — compute extraction results first, then open a short transaction just to commit), "Every episode gets a gist + embedding unconditionally" (§2.4, §6 — never gate this on whether extraction judged the episode "important"), "Entity resolution is biased toward *not* merging on ambiguity" (§4.3), "Media binaries are best-effort/ephemeral; transcripts and captions are the durable memory" (§7.3), "Check `capabilities.audioInput`/`capabilities.vision` before routing media into a model call" (§7.3, §8.1), and the "Idempotent extraction" / "Short, isolated write transactions" code patterns.
- `docs/towa-design.md` §4 in full (Write Path): §4.1 (timing — async, not sync, and why that's safe), §4.2 (queue & serialization, including the sequence diagram), §4.3 (entity resolution's three-stage pipeline). Also §2.3 (bitemporal edge semantics — you're the one writing these edges) and §2.4 (episode gist) and §7.3 (media policy — you're the one calling `fetchMedia` and doing capability-gated transcription/captioning).
- `src/db/`, `src/models/types.ts`, and `src/channels/adapter.ts` as they exist on `main` post-Phase-0.

## What to build

### 1. Drain worker (`src/core/write-path/drain-worker.ts`)

Per §4.2: an async worker (runs inside the same daemon process, no separate OS process) that polls Phase 0's queue helpers for `pending` rows, marks `in_progress`, does the slow LLM work **outside any transaction**, then commits results (KG writes + gist) and marks `done` in one short final transaction.

**Crash recovery:** on restart, re-scan for `pending`/`in_progress` rows and resume — nothing is lost, episodes are idempotently re-extractable from the raw log. This means your extraction logic must be safe to re-run on the same episode without creating duplicate nodes/edges (`CLAUDE.md`'s "Idempotent extraction" pattern) — check status before treating an episode as unprocessed.

Follow the sequence in §4.2's diagram exactly: read episode's raw turns → LLM pass (entity resolution + edges + gist, outside txn) → short txn to write KG → short txn to write gist → mark done. Batch a full episode's KG writes (nodes + edges + gist) into one short commit computed ahead of time — never a stream of tiny writes interleaved with LLM calls (`CLAUDE.md`'s "Short, isolated write transactions" pattern).

### 2. Entity resolution (`src/core/kg/entity-resolution.ts`) — §4.3

Three-stage pipeline per new episode:
1. **Within-episode coreference** ("my sister" / "she" / "Anaya") — resolved by the same extraction LLM call reading the full episode; free.
2. **Cross-episode candidate generation** — name/fuzzy string match + embedding nearest-neighbor (`sqlite-vec` over node names) + graph corroboration (nodes already connected to other entities mentioned in this episode are boosted).
3. **Bounded LLM verification** against the top few candidates: "is this new mention the same entity as existing node X (with these attributes)?" — a structured yes/no decision, not open-ended judgment, so it holds up on small models. Use Zod for this structured output, with the same capability-check + fallback pattern as elsewhere.

**Bias toward not-merging when uncertain** — no match found → create a new node, always. A false split self-heals later via a `merge_entities(a, b)` maintenance operation (you don't need to build `merge_entities` itself unless you have time left over — it's mentioned as a future maintenance op, not a hard requirement of this track's definition of done, but note it as a TODO if you skip it).

### 3. Bitemporal KG edge writes (`src/core/kg/`) — §2.3

- `valid_from`/`valid_to` are **world-time** (when a fact became/stopped being true); `ingested_at` is **transaction-time** (when Towa learned it). These are orthogonal.
- Facts are never deleted on contradiction — close the old edge (`valid_to` set) and open a new one. **`valid_to` on an open edge always uses the far-future sentinel Phase 0 defined — never `NULL`.**
- **Edge invalidation rule:** check new edges against existing edges on the same `(subject, relation)`. Close the old edge only on **clear contradiction**, and only for relations that are inherently single-valued (residence, job, relationship status). For many-valued relations (friendships, projects), new mentions are **additive by default** — never silently replace. Whether a relation is single- or many-valued is a judgment the extraction LLM call should make explicit in its structured output, not something inferred heuristically downstream.

### 4. Episode gist (`src/core/gist/`) — §2.4

Emitted in the **same** LLM pass as KG extraction (near-zero marginal cost) — a one-sentence, dense, embeddable handle on the episode. **Unconditional** — every episode gets one regardless of whether extraction judged it "important." The gist is purely a retrieval target; it never stands in for the episode's content (Track C's context assembly always reads back verbatim raw turns, never the gist, when the episode is selected).

### 5. Media handling at extraction time — §7.3

If an episode contains voice or image media: call `adapter.fetchMedia(ref)` (the injected `ChannelAdapter` instance's method — Track B's implementation, consumed here only via the interface) and check the active chat model's `capabilities.audioInput` (voice) / `capabilities.vision` (images) before passing raw bytes into a multimodal `generate()` call to produce a transcript/description. **No separate transcription library** — transcription and captioning are both just capability-gated multimodal generation calls. If the model lacks the relevant capability, degrade gracefully to recording that media of that kind existed, without content — do not fail the whole episode's extraction over a missing capability.

Remember: raw media bytes are best-effort/ephemeral (platform file refs expire); only the text-derived transcript/caption is durable. Don't build retry/persistence machinery around `fetchMedia` failing — let it fail and record "media existed, no content" per the degrade path above.

## Interface contract you must produce/consume

- **Consumes:** Phase 0's `src/core/write-path/queue.ts` read/poll helpers, Phase 0's Kysely `Database`, `LoadedChatModel`/`LoadedEmbeddingModel` from `src/models/types.ts`, `ChannelAdapter.fetchMedia` from `src/channels/adapter.ts`.
- **Produces:** a single `runExtraction(episodeId, chatModel, embeddingModel, adapter)`-shaped entry point (exact signature is your call, but keep it one clear function) that the drain worker calls per dequeued episode, and that harness-assembly (post-merge integration) wires to a polling loop startup call.

## File-level footprint

```
src/core/write-path/drain-worker.ts
src/core/kg/**
src/core/gist/**
```

Do not touch `src/db/`, `src/models/types.ts`, `src/channels/adapter.ts`, `src/channels/telegram/`, `src/core/raw-log/`, `src/core/episodes/`, `src/core/write-path/queue.ts` (Phase 0-owned — only add to `drain-worker.ts` which is new), `src/core/retrieval/`, or `src/core/context-assembly/` (Track C-owned).

## Definition of done

- Drain worker polls `pending_extraction`, processes episodes with no LLM call inside an open write transaction, and commits KG + gist writes in one short final transaction per episode.
- Re-running extraction on an already-`done` or `in_progress`-then-crashed episode does not create duplicate nodes/edges.
- Entity resolution follows all three stages and creates a new node rather than merging on any ambiguous match.
- No open KG edge ever has `valid_to = NULL`; contradictions close-and-reopen rather than delete-and-replace; single-valued vs. many-valued relations are handled per the invalidation rule.
- Every episode gets a gist + embedding, unconditionally, in the same LLM pass as KG extraction.
- Media handling checks `capabilities.audioInput`/`capabilities.vision` before any multimodal call and degrades gracefully (records existence without content) when the capability is absent.
- Typechecks cleanly against Phase 0's schema, `src/models/types.ts`, and `src/channels/adapter.ts` with no modifications to any of them.
