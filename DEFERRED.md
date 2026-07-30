# Deferred / later

Short list of items explicitly put off. Not a full backlog — only things called out as later in recent work or design §11/§13 that still apply.

## Runtime / daemon

- **Daemon restart / config-watch policy** — watch local config file(s) and restart when they change (user will bring this up later).
- **Background daemonize / systemd unit** — `towa run` stays foreground for now; detach / service packaging later.

## Media / memory

- **Query-time media re-download** — design §7.3 optional best-effort path when a retrieved caption is insufficient and the platform ref has not expired; not built (drain uses process-local cache only; no public `fetchMedia`).
- **Video inbound** — `video` / `video_note` are unsupported: static Telegram reply (`"I can't process this type of message yet."`) with `reply_parameters`; no harness turn / no raw_log persist. No `video_note` MediaKind. Outbound video send still exists.
- **Audio file inbound** — Telegram `audio` (music) and `document` with `audio/*` mime are unsupported (same static reply). Only **voice notes** (`message.voice`) are accepted; sync caption uses `/v1/audio/transcriptions`.
- **Video / file multimodal extraction** — drain describes image / voice when capabilities allow; video/file stay durable “media present” notes only (inbound video never reaches drain today).

## Maintenance

- **`merge_entities(a, b)`** — entity-resolution bias toward splits; healing merge is a later maintenance op (§4.3).
