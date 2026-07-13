# Track B — Channel Layer

## Goal

Implement `TelegramAdapter`, the sole v1 implementation of the `ChannelAdapter` interface, built on Telegraf. Wire it to append inbound events into the raw log and enqueue closed episodes for extraction, using Phase 0's already-merged helper functions.

## Dependencies

**Phase 0 only.** This track consumes:
- `src/channels/adapter.ts` — the `ChannelAdapter`/`InboundMessage`/`OutboundMessage`/`MediaRef`/`EditEvent`/`DeleteEvent` types, already defined by Phase 0. Implement against these types as merged — don't redefine them.
- `src/core/raw-log/` — `appendRawLogMessage`, `appendRawLogEdit`, `appendRawLogDelete`.
- `src/core/episodes/` — `deriveEpisodeBoundary`/`closeEpisode`.
- `src/core/write-path/queue.ts` — `enqueuePendingExtraction(episodeId)`.

Phase 0 must be merged to `main` before you branch.

## Before you start

Read, in full:
- `CLAUDE.md` — in particular the "`ChannelAdapter` pattern for channels" code pattern (new platforms are added as new adapters implementing the existing interface; core agent logic must never import or reference a specific platform) and the "Channel adapters own their transport mode entirely" invariant (§7.1) — the core harness never inspects or depends on which transport a given adapter uses.
- `docs/towa-design.md` §7 in full (Channel Layer): §7.1 (pluggable adapter interface — the exact contract you're implementing), §7.2 (`TelegramAdapter` specifics), §7.3 (media policy — read carefully, this governs how you handle `fetchMedia` and what does/doesn't get persisted).
- `src/channels/adapter.ts` as it exists on `main` post-Phase-0.

## What to build

### `TelegramAdapter` (`src/channels/telegram/`)

Per §7.2: built on **Telegraf** (already a Phase 0 dependency). Translates Telegram Bot API events into the normalized `InboundMessage`/`EditEvent`/`DeleteEvent` shapes from `adapter.ts`. Maps `OutboundMessage` variants (`text`/`image`/`video`/`audio`) to Telegraf's `sendMessage`/`sendPhoto`/`sendVideo`/`sendVoice`.

**Transport:** defaults to long-polling (`bot.launch()`) — per §7.2 and the design doc's stated rationale (zero infrastructure for a single-user personal daemon: no public HTTPS endpoint, no reverse proxy, no TLS cert). Webhook mode should remain available as an optional config path via Telegraf's own bundled `webhookCallback` — do **not** add a separate HTTP framework (Express/Fastify) to satisfy this; Telegraf covers it natively (`CLAUDE.md`: "No new dependency for something §13 already covers").

`start()` should be opaque about which transport it uses internally — this is the whole point of the `ChannelAdapter` interface per the "own their transport mode entirely" invariant. Whatever you choose (polling by default, webhook as config option), it must be fully internal to this module.

### Edit/delete handling

Per §7.2 and the raw-log invariant in `CLAUDE.md` ("Raw log is append-only. Never `UPDATE` or `DELETE` a `raw_log` row"): Telegram edit/delete events arrive as `EditEvent`/`DeleteEvent` and must be appended to the raw log as **new rows** via `appendRawLogEdit`/`appendRawLogDelete` (Phase 0) — never in-place mutation. Do not write raw SQL for this; call the Phase 0 functions.

### Wiring message receipt → raw log → episode close → extraction enqueue

On each inbound message:
1. Append to raw log via `appendRawLogMessage` (Phase 0).
2. When an assistant reply closes an episode (per §2.2's boundary rule — a run of consecutive user messages since the last assistant message, plus the assistant reply that closes it), call `closeEpisode`/`deriveEpisodeBoundary` (Phase 0) and then `enqueuePendingExtraction(episodeId)` (Phase 0).

This track does **not** implement the burst debounce logic (§6 — "wait for a short idle gap before generating a reply") or the actual reply-generation call — that's context-assembly/agent-loop territory (Track C) and/or harness integration glue done when tracks are merged together. Your job is the transport-level adapter: normalize events in, map outbound messages out, and call the Phase 0 persistence hooks at the right points. If it's ambiguous where the debounce timer should live (adapter vs. core loop), don't improvise a resolution — flag it per `CLAUDE.md`'s workflow section rather than building speculative debounce logic into the adapter.

### Media policy (§7.3)

**The raw log never stores media bytes — only a `MediaRef` reference.** `fetchMedia(ref)` on your `TelegramAdapter` should retrieve raw bytes from Telegram on demand (used later, at extraction time, by Track D — you're just implementing the method, not calling it yourself here) and return `{ data: Buffer; mimeType: string }`. Remember Telegram file references typically expire — `fetchMedia` is best-effort, not guaranteed to succeed on old refs; let it fail/reject naturally rather than adding retry/cache machinery around it (no embedding-cache-style layer, per `CLAUDE.md` anti-patterns — same reasoning applies here).

### Single allow-listed chat

Per §7.1's closing note: "single eternal chat" is a config value (one allow-listed `chatId`) on the adapter, not special-cased core logic. Implement the allow-list check inside `TelegramAdapter`, not anywhere in core.

## Interface contract you must produce

A `TelegramAdapter` factory/class that fully implements the `ChannelAdapter` interface from Phase 0's `src/channels/adapter.ts`, with no additions to that shared interface. If Telegram-specific config is needed (bot token, allow-listed chat id, polling vs. webhook choice), scope it to a `TelegramAdapterConfig` type local to `src/channels/telegram/`, not to the shared adapter interface.

## File-level footprint

```
src/channels/telegram/**
package.json   (Telegraf is already a Phase 0 dependency — only add something new if strictly required, and say so explicitly if you do)
```

Do not touch `src/channels/adapter.ts`, `src/core/raw-log/`, `src/core/episodes/`, or `src/core/write-path/queue.ts` (all Phase 0-owned) — call their exported functions, don't modify them.

## Definition of done

- `TelegramAdapter` implements every method on `ChannelAdapter` (`start`, `onMessage`, `onEdit`, `onDelete`, optionally `onPresence`, `send`, `fetchMedia`) with no `any`-typed escape hatches.
- Long-polling works by default with zero additional infrastructure; webhook mode is reachable via config without requiring a new HTTP framework dependency.
- Inbound messages/edits/deletes are persisted exclusively through Phase 0's `appendRawLog*` functions — no direct SQL in this track.
- Episode close correctly triggers `enqueuePendingExtraction`.
- `send()` correctly maps all four `OutboundMessage` variants to the corresponding Telegraf send call and returns the platform message id.
- Single allow-listed `chatId` is enforced at the adapter level.
- Typechecks cleanly against Phase 0's `src/channels/adapter.ts` with no modifications to that file.
