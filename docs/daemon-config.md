# Daemon configuration reference

Non-secrets live in a YAML file (`towa run --config-file PATH`). Secrets and a few overrides come from the environment (see `.env.example`). Relative paths resolve against the YAML file’s directory.

Schema source of truth: `packages/daemon/src/config.ts`.

## YAML

| Key | Type | Default | Required | Notes |
|---|---|---|---|---|
| `db.path` | string | `./towa.db` | no | SQLite database path. |
| `telegram.chat_id` | string \| number | — | **yes** | Single allow-listed private chat id. |
| `telegram.webhook` | object | *(omit)* | no | When set, Telegraf uses webhook mode instead of long-polling. |
| `telegram.webhook.domain` | string | — | if webhook | Public domain Telegram POSTs updates to. |
| `telegram.webhook.port` | positive int | Telegraf default | no | Local listen port for the webhook server. |
| `telegram.webhook.path` | string | Telegraf default | no | URL path for the webhook callback. |
| `telegram.webhook.host` | string | Telegraf default | no | Bind host for the local webhook server. |
| `models.chat.model` | string | — | **yes** | OpenAI-compatible chat model id. |
| `models.chat.base_url` | string | — | **yes** | OpenAI-compatible API base URL (no implicit default). |
| `models.chat.context_window` | positive int | model registry / loader | no | Required when the model id is unknown to the context-window registry. |
| `models.chat.vision` | boolean | `false` | no | Allow images into the chat model; otherwise durable “media present” notes only. |
| `models.chat.voice_note_input` | boolean | `false` | no | Allow Telegram voice notes via transcription; other audio stays unsupported. |
| `models.embedding.provider` | `"local"` \| `"openai-compatible"` | `"local"` | no | Embedding backend. |
| `models.embedding.model` | string | see notes | no | Defaults: `onnx-community/all-MiniLM-L6-v2-ONNX` (local) or `text-embedding-3-small` (openai-compatible). |
| `models.embedding.dimensions` | positive int | — | if openai-compatible | Embedding vector size; required when `provider` is `openai-compatible`. |
| `models.embedding.openai.base_url` | string | — | if openai-compatible | Embeddings API base URL; required when `provider` is `openai-compatible`. |
| `harness.system_prompt` | string \| null | pipeline default | no | `null` / omit → harness pipeline default. |
| `harness.debounce.idle_ms` | positive int | `800` | no | Quiet period before a debounced turn fires. |
| `harness.debounce.max_wait_ms` | positive int | `5000` | no | Cap on how long debounce can hold a burst. |
| `harness.session_idle_threshold_sec` | positive int | `7200` | no | Idle gap after which a new session starts. |
| `drain.poll_interval_ms` | positive int | `1000` | no | Extraction queue drain poll interval. |
| `logging.path` | string \| null | `<dirname(db.path)>/towa.log` | no | Log file path; `null` / omit → next to the DB. |
| `logging.max_bytes` | positive int | `10485760` (10 MiB) | no | Rotate to `.1` then start a fresh file. |
| `logging.stdout` | boolean | `true` | no | Also emit logs to stdout. |
| `control.port` | positive int | `18741` | no | Control HTTP port (`127.0.0.1` only). Overridden by `TOWA_CONTROL_PORT` / CLI `--port`. |
| `control.token` | string | — | no | Bearer token for CLI ↔ control HTTP; else `TOWA_CONTROL_TOKEN`. |

Not YAML knobs: packing/headroom constants, retrieval top-K, and similar harness internals stay code defaults (see design doc §5–§6).

## Environment

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | Bot API token. |
| `OPENAI_API_KEY` | if the endpoint needs a key | Shared by openai-compatible chat and/or embeddings. |
| `TELEGRAM_WEBHOOK_SECRET` | no | Maps to Telegraf `secretToken` when `telegram.webhook` is set. |
| `TOWA_CONTROL_TOKEN` | no | Bearer for control HTTP if `control.token` is not in YAML. |
| `TOWA_CONTROL_PORT` | no | Control port override (daemon + CLI); wins over YAML `control.port`. |
| `TOWA_CONFIG_FILE` | for `pnpm daemon` / `start` / `dev` | Path used when not passing `--config-file` to `towa run`. |

Example YAML: [`packages/daemon/towa.example.yaml`](../packages/daemon/towa.example.yaml).
