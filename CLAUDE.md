# CLAUDE.md — Towa

## Which file do I update?

This project keeps two documents deliberately separate. Route changes to the correct one rather than letting either grow to cover both jobs.

**Update `docs/towa-design.md` when:**

- You're making or revisiting an architectural decision — anything with real tradeoffs that were reasoned through (why SQLite over Postgres, why async extraction, why bitemporal edges, etc.).
- You're adding, removing, or reshaping a subsystem.
- You're revisiting something in its §11 (Explicitly Deferred / Rejected) with new evidence — e.g., an eval result that justifies building hierarchical rollups after all. Update the doc's reasoning _first_, then build — don't let the rejected list silently go stale.
- You're changing data-model or schema **semantics** (not just column names) — e.g., if bitemporal edge behavior changes.

**Update this file (`CLAUDE.md`) when:**

- You're adding, changing, or removing a build/lint/test/dev command.
- You're introducing a code convention or dependency choice that affects how new code should look going forward (e.g., "structured LLM output is now validated with `zod`").
- You've hit a new anti-pattern in practice worth calling out explicitly so it isn't repeated.
- You're clarifying an existing invariant's phrasing, not its meaning.

**Rule of thumb:** if the change alters _why_ the system is shaped the way it is, it belongs in the design doc. If it only changes _how code gets written_ on a design that's already settled, it belongs here. This file should stay short and cheap to load every session — if a rule needs paragraphs of justification, put the justification in the design doc and leave just the one-line rule plus a `§` cross-reference here.

---

## Project orientation

Towa is a Telegram-native AI agent harness built around one thesis: memory recall is the product — never forgetting a detail, no matter how many years pass. Full architecture and the reasoning behind every major decision live in `docs/towa-design.md`. This file is about how to write code here, not why the system is shaped the way it is — consult the design doc, don't restate it.

---

## Non-negotiable invariants

These are correctness/thesis-preserving rules. Do not "helpfully" optimize around them.

- **Raw log is append-only.** Never `UPDATE` or `DELETE` a `raw_log` row. Edits and deletes are new appended rows referencing the original. (§2.1)
- **`valid_to` always uses the far-future sentinel for open edges — never `NULL`.** Every temporal query must be a uniform `valid_from <= now AND now < valid_to`. (§2.3)
- **No LLM call runs inside an open SQLite write transaction.** Compute extraction results first, then open a short transaction just to commit them. Holds inside daemon drain tick / core `runExtraction` (§4.2).
- **Retrieval is a forced pipeline, not an optional tool call.** Query-gen → multi-signal search → memory sufficiency assess must always run; never let a model "decide" whether to search memory. Non-memory tools (web/FS) attach only to the separate answer generate. (§5.1, §5.4)
- **Agent tools are built-in + config-gated only.** Fixed tool set (`web_search`, `web_fetch`, `fs_*`); enable via daemon YAML. No user-defined tools / plugin registry. (§5.4)
- **Every episode gets a gist + embedding unconditionally** — never gated on whether extraction judged the episode "important." This is what makes the sliding context window safe to drop turns from. (§2.4, §6)
- **KG writes are durable personal facts only** — fact-level salience (identity, preferences, people/places, plans, lasting attributes); never gate the gist on importance. (§2.3, §2.4, §4)
- **Entity resolution is biased toward _not_ merging on ambiguity.** Create a new node over a speculative merge; false splits are fixable later via `merge_entities`, false merges corrupt the graph. (§4.3)
- **Media binaries are best-effort/ephemeral; transcripts and captions are the durable memory.** Never assume a `MediaRef` is fetchable indefinitely. (§7.3)
- **Media identity is real columns, not JSON.** Persist `chat_id` / `message_id` / `media_*` / `is_media_artifact` on `raw_log`. Do not reintroduce `source_meta` or scrape opaque Telegram payloads in KG/enrichment — Telegram→`MediaRef` mapping stays typed under `src/telegram/`. (§2.1, §7.3)
- **Model interfaces stay segregated:** `LoadedChatModel` and `LoadedEmbeddingModel` are separate types. Don't reintroduce an optional `embed()` on a chat model or vice versa. (§8.1)
- **Telegram owns transport; harness is programmatic.** The harness never registers bot callbacks, owns Telegraf, injects `send`, or starts an extraction poll loop. Daemon wires `telegram.start((msg) → handleTurn)`, `harness.onTurnCompleted` → `telegram.send`, owns the extraction drain loop (composes core `runExtraction` + queue helpers) — no `fetchMedia` port; enrichment reads the process-local media-byte cache filled on inbound download. Core is library-like: no long-running process starters. (§7.1, §7.3)
- **Check `capabilities.audioInput` / `capabilities.vision` before routing media into a model call.** Never assume multimodal support — degrade to recording that media existed, without content, when the active model lacks the relevant capability. (§7.3, §8.1)
- **Context packing is fixed top-K + usage-relative headroom governor — no pre-call `countTokens()`.** Working turns and retrieved episodes use code-default top-K (not YAML); tighten next turn from consecutive **answer** `usage.promptTokens` (rise / sticky / drop) — never from an absolute `contextWindow`. Do not reintroduce tiktoken/estimators, fill-until-token-budget packing, or a context-window registry (§5.2, §6, §8.3).
- **Do not combine structured `schema` with native tools on the same `generate()` call.** Sufficiency assess uses schema; tool-enabled answer generate uses tools only. (§5.2, §8.1)
- **Chat models load only via `loadOpenAICompatible`.** No native Ollama or llama.cpp loaders — daemon requires an explicit `models.chat.base_url`. Embeddings stay `loadLocalEmbeddings` or `loadOpenAICompatibleEmbeddings` (§8.2).

---

## Code patterns to follow

- **Loader factory pattern for models.** Chat is `loadOpenAICompatible`; new embedding backends (if any) are new `loadX(config)` factories — never branch provider-specific logic into call sites. (§8.1–8.2)
- **Telegram-native runtime.** Telegram lives under `@towa/core` (`src/telegram/`) as plain factories (`createTelegram`, send helpers, normalize). Do **not** reintroduce a `ChannelAdapter` or separate `@towa/telegram` package. (§7)
- **Provenance-first schema discipline.** Any new KG node or edge write must carry a pointer back to the `raw_log`/episode ids that support it. If you can't cite where a fact came from, don't write it. (§2.3, §4.3)
- **Structured-output-first prompting, with a capability fallback.** Every pipeline-facing LLM call defines an explicit output schema. Check `capabilities.structuredOutput` before assuming native JSON/tool-forced output is available; fall back to prompt-based JSON + parse + one retry otherwise. (§5.1, §8.1)
- **Idempotent extraction.** Re-running extraction on the same episode (e.g. after a crash mid-write) must be safe — no duplicate nodes/edges from a re-run. Check `pending_extraction` status before treating an episode as unprocessed. (§4.2)
- **Short, isolated write transactions.** Batch a full episode's KG writes (nodes + edges + gist) into one short commit, computed ahead of time — never a stream of tiny writes interleaved with LLM calls.
- **Use the established libraries.** Kysely (queries), Zod (schema validation), Telegraf (Telegram), Pino (logging) — see design doc §13 for the full list and the reasoning behind each. Check §13 before adding a new dependency for something it already covers.
- **Logging via `configureLogging` / `getLogger` only.** Never call bare `pino()` outside the logging module; never thread `logger` through deps. Daemon calls `configureLogging` once at `towa run`; everywhere else uses `getLogger(name)`. (§13)
- **Daemon config is YAML + secret env.** Non-secrets in the config file; API keys / bot token / control tokens from env. Do not reintroduce env-everything config. (§13)

---

## Anti-patterns to resist

Pulled from the design doc's §11 (Explicitly Deferred / Rejected) — these were considered and turned down for stated reasons. Don't reintroduce them without first updating the design doc with new evidence.

- **No speculative abstraction.** No plugin registry, no premature hook system, no config option for a use case that doesn't exist yet. Especially watch for this given the project's known tendency to over-engineer.
- **No ChannelAdapter / multi-channel plugin layer.** Telegram-native; daemon wires telegram handlers → harness methods and owns send + the extraction poll loop. (§7, §11)
- **No message broker.** The pending_extraction queue is a SQLite table + a daemon drain loop. Don't reach for RabbitMQ/Redis/etc. for a single-writer, single-user flow.
- **No hierarchical rollup summaries** (day/month/quarter trees) without eval evidence that query-time synthesis + the KG genuinely can't cover a real query class.
- **No embedding cache layer.** `embed()` is called directly against the loaded model. This was tried and deliberately backed out.
- **No dedicated graph database.** Graph traversal is recursive CTEs over SQLite tables. The performance case for Neo4j/AGE doesn't exist at this project's scale.
- **No synchronous/inline extraction.** Never block a reply on the KG-extraction LLM call.
- **No third relevance judge on top of answer.** Memory sufficiency is a dedicated structured assess call; the user-facing reply is a separate plain-text (optionally tool-enabled) generate. Do not add another judge LLM after `generateAnswer`. (§5.2, §11)
- **No user-defined / plugin tools.** Built-in tools only, enabled via YAML booleans. (§5.4, §11)
- **No ReasoningBank-style procedural memory store.** If a future retrieval-strategy-learning layer is proposed, it must be explicitly gated behind eval evidence per §11 — it is not a general memory mechanism and should never replace the raw log / KG / gist planes.
- **No dedicated `loadOllama` / `loadLlamaCpp`.** Chat is openai-compatible only with an explicit `base_url`. Do not reintroduce a second HTTP client, in-process GGUF runtime, or an implicit Ollama default (§8.2, §11).
- **No pre-call `countTokens()` packing.** Fixed top-K + next-turn usage-relative headroom from answer response usage only — no absolute context-window registry or `capabilities.contextWindow` (§5.2, §6, §8.3, §11).
- **No new dependency for something §13 already covers.** Check the frameworks table before adding an ORM, HTTP _framework_ (control plane uses raw `node:http` only), CLI framework, audio-transcription library, or alternative logger.

---

## Style

- TypeScript, strict mode.
- Prefer plain functions and factory functions over classes where reasonable (matches the loader-factory and Telegram factory patterns already established).
- Module/folder naming should mirror the design doc's structure where practical — see §12's suggested repo layout as the starting scaffold, not a strict requirement.
- Core libraries are chosen (§13 in the design doc) — Kysely, Zod, Telegraf, Pino.
- **Build / typecheck:** from the repo root, `pnpm build` / `pnpm typecheck` run recursively across `packages/*` and `evals`. Per-package: `pnpm --filter @towa/core build`, etc. No lint or unit-test runner yet (evals are the correctness signal per design doc §9.3).
- **Workspace:** root is a private aggregator (`towa-monorepo`). Libraries/apps under `packages/` — `@towa/core` (harness/DB/ai/Telegram/logging), `@towa/daemon` (Telegram daemon + `towa` CLI: `run`/`stop`/`status`/`ping`/`logs`). `evals` is a workspace member. Daemon emits to `dist/` and runs via `node --watch-path` (not `tsx`) so debugger source maps work. Prefer `towa run --config-file`; `pnpm --filter @towa/daemon dev` watches `@towa/core` + the daemon (needs `TOWA_CONFIG_FILE`), then attaches inspect on `127.0.0.1:11001`.
- **Daemon wiring:** `configureLogging` once, load models from YAML+secret env, open the DB, `createTelegram`, `createHarness({ db, models, … })` (no transport ports / no logger deps), `harness.onTurnCompleted` → `telegram.send`, start control HTTP + drain poll loop, then `telegram.start((msg) => harness.handleTurn(msg))` — do not reimplement debounce / retrieval / late-arrival regenerate or move KG write logic into the daemon (§6, §7, §13).

---

## Workflow for coding agents

- Before implementing a new subsystem, check `docs/towa-design.md` for whether the shape is already decided. If it's covered, follow it — don't re-derive an alternative design mid-implementation.
- If a real design question comes up that the doc doesn't answer, **flag it rather than improvising a resolution silently.** Architectural decisions get made once, deliberately, not implicitly through whatever a coding session happened to produce.
- Prefer small, reviewable diffs over large speculative ones.
