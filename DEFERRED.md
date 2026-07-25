# Deferred / later

Short list of items explicitly put off. Not a full backlog — only things called out as later in recent work or design §11/§13 that still apply.

## Runtime / daemon

- **Daemon restart / config-watch policy** — watch local config file(s) and restart when they change (user will bring this up later).
- **CLI beyond stub / real `towa start`** — stub bin only; product commands + config system still later (§13).

## Media / memory

- **Full multimodal generation on the reply path** — inbound may carry base64 on `media.data`, but harness generation still text-notes media; transcripts/captions remain drain-time enrichment (§7.3).
- **Query-time media re-download** — design §7.3 optional best-effort path when a retrieved caption is insufficient and the platform ref has not expired; not built (drain uses process-local cache only; no public `fetchMedia`).
- **Video / file multimodal extraction** — drain describes image/audio when capabilities allow; video/file stay durable “media present” notes only.

## Maintenance

- **`merge_entities(a, b)`** — entity-resolution bias toward splits; healing merge is a later maintenance op (§4.3).
