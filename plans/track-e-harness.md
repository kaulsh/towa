# Track E — Harness / Agent Loop

## Goal

Export the core agent loop from `towa` so consumers (e.g. `examples/telegram-daemon`) only configure env, load models, construct a `ChannelAdapter`, and call `createHarness(...).start()` — instead of re-implementing debounce, turn handling, retrieval wire-up, and drain startup themselves.

## Dependencies

**Current** `main` **(Phase 0 + Tracks A–D already merged).** This track consumes existing entry points; it does not reimplement them:

- `ChannelAdapter` (`src/channels/adapter.ts`) — the loop talks **only** to this interface (§7.1); never imports Telegram.
- `runRetrievalAndGenerate` (`src/core/retrieval/pipeline.ts`) — Track C per-turn entry.
- `loadRecentWorkingTurns` / working-context helpers (`src/core/context-assembly/`).
- `startDrainWorker` (`src/core/write-path/drain-worker.ts`) — Track D drain loop.
- `openDatabase` / Kysely `Database` — already opened by the caller and injected.
- `LoadedChatModel` / `LoadedEmbeddingModel` — already loaded by the caller and injected (Track A loaders stay in the consumer / example).

Reference implementation to **lift and slim**, not discard: `examples/telegram-daemon/src/{main,debounce}.ts` already wires the correct runtime shape. Move the loop into `towa`; leave Telegram/env/loader bootstrap in the example.

## Before you start

Read, in full:

- `CLAUDE.md` — especially channel-adapter opacity, forced retrieval, token budgets via `countTokens()`, no speculative plugin/hook systems.
- `docs/towa-design.md` §6 (Agent Loop & Context Assembly — debounce, working-context, session boundary), §7.1 (core agent loop ↔ `ChannelAdapter` only), §8.2 last paragraph (per-role model injection: `chatModel` / `extractionModel` / `embeddingModel`), §13 config note (“code that imports the harness”).
- Existing plans’ deferred notes: Track B (debounce + reply not in adapter), Track C (`runRetrievalAndGenerate` for harness wire-up), Track D (drain startup for harness), Track A (per-role config is harness assembly).
- Current `examples/telegram-daemon/` and `src/index.ts` (today the example *is* the harness).



## What to build



### Core harness (`src/core/harness/` — or `src/core/agent-loop/` if you prefer that name; pick one and stick to it)

A factory along the lines of:

```typescript
createHarness(deps: {
  db: Kysely<Database>;          // already open + migrated
  channel: ChannelAdapter;       // any adapter; not Telegram-specific
  chatModel: LoadedChatModel;    // reply / retrieval generation
  embeddingModel: LoadedEmbeddingModel;
  extractionModel?: LoadedChatModel; // optional; default = chatModel (§8.2)
  systemPrompt?: string;
  debounce?: { idleMs: number; maxWaitMs: number };
  sessionIdleThresholdSec?: number; // pass through to working-context if applicable
  logger?: /* pino-compatible or structured logger */;
}): {
  start(): void;                 // register handlers, start drain, channel.start()
  stop(): Promise<void>;         // stop drain, clear debounce; do not assume channel.stop()
}
```

Exact names/types may vary, but keep **one clear factory + start/stop**. No plugin registry, no hook system, no config framework (`CLAUDE.md` / §13).

### Behavior `start()` must own (§6 + existing example flow)

1. **Start the drain worker** with `db`, `extractionModel ?? chatModel`, `embeddingModel`, `channel` (for `fetchMedia`).
2. **Burst debounce** (ephemeral, never persisted): after inbound messages, wait for a short idle gap (reset by further messages), with a max-wait cap so long monologues still get a reply. Prefer also widening/resetting idle via `channel.onPresence` when the adapter provides it (§6 / optional `onPresence` on the interface).
3. **On debounce fire:** for the latest message in the burst (earlier burst messages are already in `raw_log` via the adapter), load working turns → call `runRetrievalAndGenerate` → `channel.send(chatId, { type: 'text', text: answer })`.
4. **Serialize turns** so overlapping generations don’t interleave (queue / busy flag as in the example is fine).
5. **Edits:** register `onEdit` at least for logging / no auto-reply (adapter already persists append-only edits). Do not invent delete/presence reply behavior Telegram can’t deliver.
6. **Errors:** log and optionally send a short failure notice via `channel.send`; don’t crash the process on a single turn failure.
7. Call `channel.start()` last (or after handlers are registered — match safe order so no events are missed).

The harness must **not**:

- Import `createTelegramAdapter` or any `channels/telegram/*` symbol.
- Parse `process.env` / own dotenv (consumer’s job).
- Call model loaders (consumer injects already-loaded models).
- Reimplement retrieval, extraction, or raw-log persistence.



### Lift debounce out of the example

Move the burst-debouncer from `examples/telegram-daemon/src/debounce.ts` into the harness module (or a sibling file under the same footprint). Delete or thin the example’s copy.

### Slim `examples/telegram-daemon`

After this track, the example should roughly:

1. Load `.env` / config.
2. `loadOllama` / etc. → `chatModel` + `embeddingModel`.
3. `openDatabase`.
4. `createTelegramAdapter(db, { botToken, chatId })`.
5. `createHarness({ db, channel: adapter, chatModel, embeddingModel, ... }).start()`.
6. Handle process signals via `harness.stop()` + `db.destroy()`.

Update the example `README.md` to describe “configure + import harness,” not “wires Track A–D by hand.”

### Public exports

Update `src/index.ts` so the primary consumer path is the harness. Keep exporting loaders, `createTelegramAdapter`, `openDatabase`, and types as needed for the example’s bootstrap. Prefer **not** requiring the example to import `runRetrievalAndGenerate` / `startDrainWorker` / `loadRecentWorkingTurns` directly once the harness owns that wire-up (advanced re-exports may remain, but the example must not need them).

### Optional doc touch

If you add a folder under `src/core/`, add one line to `docs/towa-design.md` §12 Suggested Repo Layout for it (harness / agent-loop). Do not rewrite §6 — behavior is already specified there.

## Interface contract


| Role                 | Contract                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Produces**         | `createHarness` (or equivalent) + `start`/`stop`; burst debounce owned by harness; exported from `towa` package root                  |
| **Consumes**         | Injected `ChannelAdapter`, models, `db`; Track C `runRetrievalAndGenerate`; Track D `startDrainWorker`; context-assembly load helpers |
| **Example produces** | Env/config + loader calls + Telegram adapter construction only                                                                        |




## File-level footprint

```
src/core/harness/**          # or src/core/agent-loop/** — pick one
src/index.ts                 # export harness; tighten example-facing surface
examples/telegram-daemon/**  # slim to configure + start harness
docs/towa-design.md          # optional one-line §12 layout addition only
CLAUDE.md                    # only if a new one-line convention is warranted (e.g. “daemon consumers use createHarness”)
```

Do **not** rewrite Track A–D internals (retrieval pipeline, KG, telegram adapter implementation, loaders) except for tiny call-signature glue if the harness genuinely cannot wire them otherwise — prefer adapting at the harness boundary. Do not add a CLI framework or HTTP framework.

## Definition of done

- [ ] `createHarness` (or equivalent) lives in `towa` and owns debounce → working turns → `runRetrievalAndGenerate` → `channel.send`, plus drain-worker startup.
- [ ] Harness imports **zero** Telegram-specific modules; example is the only place that constructs `createTelegramAdapter`.
- [ ] `examples/telegram-daemon` no longer contains a hand-rolled agent loop / debounce module; it configures and starts the harness.
- [ ] Optional `extractionModel` is accepted and passed to the drain worker (defaulting to `chatModel`).
- [ ] Presence widens debounce when `onPresence` is available; when not, idle/max-wait debounce still works.
- [ ] `pnpm build` / `pnpm typecheck` clean at repo root; example typechecks.
- [ ] **Self-authored code-flow review guide** produced at the end of implementation (see below) — not a risk-tier file list.



### Code-flow review guide (required in your completion report)

Once implementation is complete, produce a short guide for whoever reviews the diff, structured as a walkthrough of the code’s execution path:

1. Open with one line: path + branch.
2. Section **How to review this (code flow)** — name the single primary entry point (e.g. `createHarness` → `start`), then walk the happy-path call sequence in execution order (“Start at `X` — … It calls `Y` — open that next …”). At each hop: file path, key function, one sentence of *why you’re there in the flow*.
3. Keep mutation / external / LLM steps **in place** in the sequence where they run — never pulled into a separate “high risk” tier.
4. Call out branches (debounce fire vs max-wait, presence reset, turn queue while busy, turn error path, `stop`) and name the owning function.
5. End with what to skim once the flow is clear (types, barrels, pure timer helpers if trivial).

Tone: senior engineer walking a colleague through the code — imperative navigation. Size to the actual diff.
