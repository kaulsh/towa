# Towa daemon (`@towa/daemon`)

Configures and starts the Towa harness against Telegram. The daemon owns bot
callbacks, `processNextExtraction`, the extraction poll loop, and the control
plane (`POST /command`, `GET /logs`). Core stays library-like.

## Prerequisites

- Node 22+ and pnpm 10
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- Your private chat id (allow-listed; single eternal chat)
- A chat model endpoint — any OpenAI-compatible `base_url` (required in YAML; e.g. Ollama, OpenAI, vLLM)
- First run of local embeddings downloads the ONNX MiniLM model (CPU)

## Setup

From the **repo root**:

```bash
pnpm -r i
pnpm build
```

Configure under `packages/daemon`:

```bash
cd packages/daemon
cp towa.example.yaml towa.yaml   # set telegram.chat_id, models, …
cp .env.example .env             # TELEGRAM_BOT_TOKEN=…, TOWA_CONFIG_FILE=./towa.yaml
```

## Run from local repository

From the **repo root** (after setup + build):

```bash
# Foreground daemon (uses TOWA_CONFIG_FILE; control HTTP on 127.0.0.1:18741 by default)
pnpm daemon

# CLI — pass args after `--`
pnpm cli --help
pnpm cli -- ping
pnpm cli -- status
pnpm cli -- logs --lines 50 --no-follow
pnpm cli -- stop
```

Equivalent CLI start (also from root):

```bash
pnpm cli -- run --config-file packages/daemon/towa.yaml
```

If you set `control.port` in YAML (or `TOWA_CONTROL_PORT`), pass the same to the CLI:

```bash
pnpm cli -- status --port 9999
TOWA_CONTROL_PORT=9999 pnpm cli -- status
```

## Package scripts (dev)

From `packages/daemon` (set `TOWA_CONFIG_FILE=./towa.yaml` in `.env`):

```bash
pnpm start   # same bootstrap as root `pnpm daemon`
pnpm dev     # watch + inspect on 127.0.0.1:11001
pnpm cli -- ping
```

## Secrets (env only)

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot API token |
| `OPENAI_API_KEY` | if openai-compatible needs a key | Chat and/or embeddings |
| `TELEGRAM_WEBHOOK_SECRET` | if using webhook secret | Maps to Telegraf `secretToken` |
| `TOWA_CONTROL_TOKEN` | no | Bearer token for CLI ↔ control HTTP (or `control.token` in YAML) |
| `TOWA_CONTROL_PORT` | no | Control HTTP port (default `18741`); same value the daemon uses if YAML omits `control.port` |
| `TOWA_CONFIG_FILE` | for `pnpm daemon` / `start` / `dev` | Path passed to the same bootstrap as `towa run` |

Everything else (chat id, model ids, debounce, logging path, optional `control.port`, …) lives in the YAML file — see `towa.example.yaml`.
