# CLAUDE.md — Towa

## Which file do I update?

This project keeps two documents deliberately separate. Route changes to the correct one rather than letting either grow to cover both jobs.

**Update `docs/towa-design.md` when:**
- You're making or revisiting an architectural decision — anything with real tradeoffs that were reasoned through (why SQLite over Postgres, why async extraction, why bitemporal edges, etc.).
- You're adding, removing, or reshaping a subsystem.
- You're revisiting something in its §11 (Explicitly Deferred / Rejected) with new evidence — e.g., an eval result that justifies building hierarchical rollups after all. Update the doc's reasoning *first*, then build — don't let the rejected list silently go stale.
- You're changing data-model or schema **semantics** (not just column names) — e.g., if bitemporal edge behavior changes.

**Update this file (`CLAUDE.md`) when:**
- You're adding, changing, or removing a build/lint/test/dev command.
- You're introducing a code convention or dependency choice that affects how new code should look going forward (e.g., "structured LLM output is now validated with `zod`").
- You've hit a new anti-pattern in practice worth calling out explicitly so it isn't repeated.
- You're clarifying an existing invariant's phrasing, not its meaning.

**Rule of thumb:** if the change alters *why* the system is shaped the way it is, it belongs in the design doc. If it only changes *how code gets written* on a design that's already settled, it belongs here. This file should stay short and cheap to load every session — if a rule needs paragraphs of justification, put the justification in the design doc and leave just the one-line rule plus a `§` cross-reference here.

---

## Project orientation

Towa is a Telegram-native AI agent harness built around one thesis: memory recall is the product — never forgetting a detail, no matter how many years pass. Full architecture and the reasoning behind every major decision live in `docs/towa-design.md`. This file is about how to write code here, not why the system is shaped the way it is — consult the design doc, don't restate it.

---

## Non-negotiable invariants

These are correctness/thesis-preserving rules. Do not "helpfully" optimize around them.

- **Raw log is append-only.** Never `UPDATE` or `DELETE` a `raw_log` row. Edits and deletes are new appended rows referencing the original. (§2.1)
- **`valid_to` always uses the far-future sentinel for open edges — never `NULL`.** Every temporal query must be a uniform `valid_from <= now AND now < valid_to`. (§2.3)
- **No LLM call runs inside an open SQLite write transaction.** Compute extraction results first, then open a short transaction just to commit them. (§4.2)
- **Retrieval is a forced pipeline, not an optional tool call.** Query-gen → multi-signal search → gate must always run; never let a model "decide" whether to search. (§5.1)
- **Every episode gets a gist + embedding unconditionally** — never gated on whether extraction judged the episode "important." This is what makes the sliding context window safe to drop turns from. (§2.4, §6)
- **Entity resolution is biased toward *not* merging on ambiguity.** Create a new node over a speculative merge; false splits are fixable later via `merge_entities`, false merges corrupt the graph. (§4.3)
- **Media binaries are best-effort/ephemeral; transcripts and captions are the durable memory.** Never assume a `MediaRef` is fetchable indefinitely. (§7.3)
- **Model interfaces stay segregated:** `LoadedChatModel` and `LoadedEmbeddingModel` are separate types. Don't reintroduce an optional `embed()` on a chat model or vice versa. (§8.1)
- **Channel adapters own their transport mode entirely** (polling / webhook / websocket). The core harness never inspects or depends on which transport a given adapter uses — it only sees normalized event callbacks. (§7.1)
- **Check `capabilities.audioInput` / `capabilities.vision` before routing media into a model call.** Never assume multimodal support — degrade to recording that media existed, without content, when the active model lacks the relevant capability. (§7.3, §8.1)
- **Token budgets are computed via `countTokens()`, never hardcoded.** Any code touching the working-context or retrieved-context budget must measure against the active model's own `countTokens()` output (§5, §6, §8.3) — tokenization differs by provider, so a shared estimate is not a substitute.

---

## Code patterns to follow

- **Loader factory pattern for models.** New providers are added as a new `loadX(config)` function returning `LoadedChatModel` or `LoadedEmbeddingModel` — never by branching provider-specific logic into call sites. (§8.1–8.2)
- **`ChannelAdapter` pattern for channels.** New platforms (Slack, WhatsApp, etc.) are added as a new adapter implementing the existing interface — core agent logic must never import or reference a specific platform. (§7.1)
- **Provenance-first schema discipline.** Any new KG node or edge write must carry a pointer back to the `raw_log`/episode ids that support it. If you can't cite where a fact came from, don't write it. (§2.3, §4.3)
- **Structured-output-first prompting, with a capability fallback.** Every pipeline-facing LLM call defines an explicit output schema. Check `capabilities.structuredOutput` before assuming native JSON/tool-forced output is available; fall back to prompt-based JSON + parse + one retry otherwise. (§5.1, §8.1)
- **Idempotent extraction.** Re-running extraction on the same episode (e.g. after a crash mid-write) must be safe — no duplicate nodes/edges from a re-run. Check `pending_extraction` status before treating an episode as unprocessed. (§4.2)
- **Short, isolated write transactions.** Batch a full episode's KG writes (nodes + edges + gist) into one short commit, computed ahead of time — never a stream of tiny writes interleaved with LLM calls.
- **Use the established libraries.** Kysely (queries), Zod (schema validation), Telegraf (Telegram), Pino (logging) — see design doc §13 for the full list and the reasoning behind each. Check §13 before adding a new dependency for something it already covers.

---

## Anti-patterns to resist

Pulled from the design doc's §11 (Explicitly Deferred / Rejected) — these were considered and turned down for stated reasons. Don't reintroduce them without first updating the design doc with new evidence.

- **No speculative abstraction.** No plugin registry, no premature hook system, no config option for a use case that doesn't exist yet. Especially watch for this given the project's known tendency to over-engineer.
- **No message broker.** The write-path queue is a SQLite table + a drain loop. Don't reach for RabbitMQ/Redis/etc. for a single-writer, single-user flow.
- **No hierarchical rollup summaries** (day/month/quarter trees) without eval evidence that query-time synthesis + the KG genuinely can't cover a real query class.
- **No embedding cache layer.** `embed()` is called directly against the loaded model. This was tried and deliberately backed out.
- **No dedicated graph database.** Graph traversal is recursive CTEs over SQLite tables. The performance case for Neo4j/AGE doesn't exist at this project's scale.
- **No synchronous/inline extraction.** Never block a reply on the KG-extraction LLM call.
- **No separate relevance-judge LLM call.** The generation call doubles as the sufficiency gate via structured output; don't add a dedicated judge model on top of it.
- **No ReasoningBank-style procedural memory store.** If a future retrieval-strategy-learning layer is proposed, it must be explicitly gated behind eval evidence per §11 — it is not a general memory mechanism and should never replace the raw log / KG / gist planes.
- **No new dependency for something §13 already covers.** Check the frameworks table before adding an ORM, HTTP framework, CLI framework, audio-transcription library, or alternative logger.

---

## Style

- TypeScript, strict mode.
- Prefer plain functions and factory functions over classes where reasonable (matches the loader-factory and adapter patterns already established).
- Module/folder naming should mirror the design doc's structure where practical — see §12's suggested repo layout as the starting scaffold, not a strict requirement.
- Core libraries are chosen (§13 in the design doc) — Kysely, Zod, Telegraf, Pino.
- **Build / typecheck:** `pnpm build` (`tsc`), `pnpm typecheck` (`tsc --noEmit`). No lint or unit-test runner yet (evals are the correctness signal per design doc §9.3).

---

## Workflow for coding agents

- Before implementing a new subsystem, check `docs/towa-design.md` for whether the shape is already decided. If it's covered, follow it — don't re-derive an alternative design mid-implementation.
- If a real design question comes up that the doc doesn't answer, **flag it rather than improvising a resolution silently.** Architectural decisions get made once, deliberately, not implicitly through whatever a coding session happened to produce.
- Prefer small, reviewable diffs over large speculative ones.
