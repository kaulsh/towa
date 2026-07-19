# Track F — Durable media text artifacts

## Goal

Persist extraction-time transcripts/captions into durable, FTS-indexed memory (§7.3), and make every read path that surfaces verbatim turns see the enriched text — not only the in-memory extraction pass.

## Dependencies

**Current `main` (Phase 0 + Tracks A–E).** No Phase 0 for this wave.

Consumes (do not reimplement):

- `enrichTurnsWithMedia` — `src/core/kg/media.ts` (already produces text artifacts in memory)
- `appendRawLogEdit` / FTS reindex — `src/core/raw-log/index.ts`
- `runExtraction` — `src/core/kg/run-extraction.ts`
- Episode turn loaders — `src/core/retrieval/assemble.ts` (`loadEpisodeTurns`), `src/core/context-assembly/load-turns.ts`, `src/core/kg/run-extraction.ts` (loads turns before enrich)

## Before you start

Read in full:

- `CLAUDE.md` — **Raw log is append-only** (never `UPDATE`/`DELETE` a `raw_log` row); media binaries ephemeral / transcripts durable (§7.3); no LLM inside an open write txn.
- `docs/towa-design.md` §2.1 (raw_log + edit_of semantics), §4 (extraction timing), §7.3 (media policy — especially “MediaRef **plus**, once available, a text-derived artifact”).
- Current `src/core/kg/media.ts` and `run-extraction.ts` — today enrichment is **in-memory only** for the extract LLM call; nothing is written back.

## Why this is required

Design §2.1: `content` is “verbatim text (or transcript/caption for media)”.
Design §7.3: raw log never stores bytes — only `MediaRef` + text-derived artifact once available.

Today: `enrichTurnsWithMedia` mutates turn objects in RAM for extraction, then discards them. Working context and retrieved episodes keep the original (often empty / caption-only) `content`. After Telegram file refs expire, the transcript is gone forever unless the gist/KG happened to retain fragments.

## Critical constraint: edit ids vs episode ranges

Episodes are closed **before** extraction runs (`end_msg_id` is the assistant reply). Media enrichment therefore happens **after** the episode id range is fixed.

If you `appendRawLogEdit`, the new row gets a **new** `raw_log.id` **outside** `[start_msg_id, end_msg_id]`. Naïve range scans (`assemble.loadEpisodeTurns`, extraction’s turn load) will **miss** the enriched content.

**Agreed approach (human-confirmed):**

1. Persist via **`appendRawLogEdit`** (never in-place `UPDATE`).
2. Introduce a shared **edit-aware resolve** helper used by all verbatim-turn loaders so that for each original message id in range, content is the **latest non-deleted edit** targeting that id (or the original if none), and edit rows themselves are not double-listed as separate turns.

Suggested shape (names flexible):

```typescript
// e.g. src/core/raw-log/resolve-turns.ts
resolveTurnsForIdRange(db, startId, endId): Promise<ResolvedTurn[]>
// Also useful: resolveLatestContent(db, originalIds: number[])
```

Semantics:

- Start from rows with `id ∈ [start, end]`, `edit_of IS NULL`, not superseded by a delete-marker targeting them.
- For each such original, if there exists a later edit chain (`edit_of` → …) with `deleted_marker = 0` on the tip, use the tip’s `content` (and keep the **original** `id` as the turn id for episode identity / provenance).
- Do not emit edit rows as additional turns inside the episode.

FTS: `appendRawLogEdit` already reindexes **original** id with new content — keep that; don’t invent a second index plan.

## What to build

### 1. Persist after enrich (write path)

In `runExtraction`, after `enrichTurnsWithMedia`:

- For each turn whose enriched `content` differs from the DB original (media was present / artifact appended):
  - Call `appendRawLogEdit` with the enriched content.
  - `source_meta` should record that this is a system media-artifact edit (e.g. `{ kind: "media_artifact", of: originalId, mediaRef }`) — not a user Telegram edit. Do not invent a new table.
- Still use **enriched** turns for the extract LLM call (unchanged).
- Keep all LLM/`fetchMedia` work **outside** the final KG write transaction (§4.2). Edit appends may be their own short writes before the KG commit (or batched in a short txn that is still separate from the LLM). Prefer short, isolated writes — no open txn across `generate()`.

Idempotency: re-running extraction on the same episode must not spam duplicate identical edits. Options (pick one, document in code):

- Skip append if latest resolved content already equals enriched content; or
- Clear prior `media_artifact` edits for those originals in `clearEpisodeExtractionArtifacts` then re-append (still append-only delete markers / new edits — never `UPDATE` originals).

Bias toward **not** leaving stale transcripts if re-extract improves them.

### 2. Edit-aware reads (required for durability to matter)

Replace naïve range loads in at least:

- `src/core/retrieval/assemble.ts` — `loadEpisodeTurns`
- `src/core/context-assembly/load-turns.ts` — working-context buffer
- `src/core/kg/run-extraction.ts` — turn load before enrich (so re-extract sees prior artifacts and can skip redundant work)

`src/core/kg/run-extraction.ts` / episodes helpers if they load raw turns the same way.

### 3. Keep media enrich behavior

Do **not** remove capability gating or degrade-to-“media present” paths in `media.ts`. This track is about **persisting** what enrich already produces.

### Out of scope (separate Track H)

- Query-time on-demand `fetchMedia` when caption insufficient (§7.3 optional path) — **Track H**, after this lands.
- Video/file multimodal generation beyond the current “present, no content” note.

## Interface contract

| Produce | Consume |
|---|---|
| Edit-aware turn resolution used by loaders | Existing `appendRawLogEdit`, `enrichTurnsWithMedia` |
| Durable enriched `content` visible to FTS + assemble + working context | No new public `src/index.ts` exports required |

Do **not** touch `evals/**` (Track G) or add query-time media fetch (Track H).

## File-level footprint

**Expected:**

- `src/core/kg/run-extraction.ts`
- `src/core/kg/media.ts` (only if persistence/idempotency helpers belong next to enrich)
- `src/core/raw-log/` — new resolve helper + barrel export
- `src/core/context-assembly/load-turns.ts`
- `src/core/retrieval/assemble.ts`
- Possibly `src/core/kg/idempotency.ts` if clearing prior media-artifact edits on re-run
- `docs/towa-design.md` — only if you must clarify edit-resolution-for-reads (prefer a short note under §2.1 / §7.3 if behavior wasn’t explicit)

**Do not modify:** `evals/**`, harness reply-path multimodal (still text-only at reply time — durable text is the fix), Telegram adapter send path.

## Definition of done

- [x] After extraction of an episode containing image/audio (with capable model), `raw_log` has an append-only edit whose resolved content includes the transcript/caption; original row untouched.
- [x] `loadEpisodeTurns` / `loadRecentWorkingTurns` return enriched content for that message (original id preserved).
- [x] FTS search can hit tokens from the transcript (via existing edit indexing).
- [x] Re-running extraction is safe (no unbounded duplicate edits; no `UPDATE`/`DELETE` on originals).
- [x] `pnpm build` + `pnpm typecheck` pass.
- [x] Self-authored **code-flow review guide** written (see below) — usually as a short section at the bottom of this file or `plans/review-track-f.md`.

### Code-flow review guide (required at completion)

After implementation, append a guide that:

1. Opens with path + branch.
2. **How to review this (code flow):** start at `runExtraction` → `enrichTurnsWithMedia` → persist edits → then show one read path (`loadEpisodeTurns` or `loadRecentWorkingTurns`) resolving through the new helper.
3. Keep mutation / `fetchMedia` / LLM steps in execution order.
4. Call out idempotent re-run and degrade-without-capability branches.
5. List what to skim (types, barrels).

## Coordination

- Track G (evals) may seed DBs with pre-written `content` and does not depend on this track.
- Track H (query-time media) **depends on this track** — do not start H until F is merged.

---

## Code-flow review guide (Track F)

**Path:** `/home/kaulshashank/.cursor/worktrees/track-f-5fce3ceb/towa-29d20acf6906`  
**Branch:** `track-f-durable-media-text`  
**WORKTREE_ID:** `track-f-5fce3ceb`

### How to review this (code flow)

Follow execution order from the real extraction entry point — not a risk-tiered file list.

1. **`runExtraction`** (`src/core/kg/run-extraction.ts`)  
   Status check → `markExtractionInProgress` → `clearEpisodeExtractionArtifacts` (KG/gist only; does **not** touch raw_log) → **`resolveTurnsForIdRange(start, end)`** so prior `media_artifact` tips outside the episode id range are already visible.

2. **Wire base for enrich**  
   Map each resolved turn to `content: wireContent` (latest non-`media_artifact` caption) + original `sourceMeta` (still carries `MediaRef`). This prevents double-appending transcripts on re-extract.

3. **`enrichTurnsWithMedia`** (`src/core/kg/media.ts`) — still in-memory, still capability-gated:  
   - no `MediaRef` → pass through  
   - audio without `capabilities.audioInput` / image without `vision` → degrade string, no `fetchMedia`  
   - video/file → durable “present, no content” note  
   - capable path → `adapter.fetchMedia` → multimodal `chatModel.generate` → artifact text  
   All of this stays **outside** any KG write transaction.

4. **`persistMediaTextArtifacts`** (`src/core/kg/media.ts`) — short isolated writes:  
   For each enriched turn with a `MediaRef` whose content **differs** from the pre-enrich tip → `appendRawLogEdit` with `source_meta: { kind: "media_artifact", of, mediaRef }`.  
   Original row untouched. `appendRawLogEdit` reindexes FTS under the **original** id.  
   Identical tip → skip (idempotent re-run; no edit spam). Improved transcript → new append-only edit.

5. **Extract LLM + entity resolve + embed** (unchanged) still use the enriched turns; then **`commitExtraction`** in one short txn.

6. **Read path (pick one to walk):**  
   - Retrieved episodes: `assembleRetrievedContext` → `loadEpisodeTurns` → `resolveTurnsForIdRange` → tip `content`, original `id`.  
   - Working context: `loadRecentWorkingTurns` → `resolveRecentTurns` → same tip resolution; edit rows never appear as extra turns.

### Idempotent re-run & degrade branches

- Re-run with same artifact text: resolve loads tip → enrich from `wireContent` → persist sees `enriched === tip` → no new row.  
- Re-run with better transcript: new `appendRawLogEdit`; tip advances; no `UPDATE`/`DELETE` on originals.  
- Degrade-without-capability / fetch failure: enrich still produces a note string; persist writes it the same way (durable “media existed”).

### Skim only

- `ResolvedTurn` + helpers in `src/core/raw-log/resolve-turns.ts`  
- Barrel re-exports in `src/core/raw-log/index.ts`  
- Design notes under §2.1 (read resolution) and §7.3 (`media_artifact` write-back) in `docs/towa-design.md`
