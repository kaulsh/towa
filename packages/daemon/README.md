# Towa daemon (`@towa/daemon`)

Configures and starts the Towa harness against Telegram:

`towa run --config-file ./towa.yaml` → YAML + secret env → logging → models → DB → `Telegram` → `createHarness` → drain loop → localhost control HTTP.

The daemon owns bot callbacks, `processNextExtraction`, the extraction poll loop, and the control plane (`POST /command`, `GET /logs`). Core stays library-like.

## Prerequisites

- Node 22+ and pnpm 10
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- Your private chat id (allow-listed; single eternal chat)
- A chat model endpoint — default is [Ollama](https://ollama.com) with `llama3.1:8b`
- First run of local embeddings downloads the ONNX MiniLM model (CPU)

## Setup

From the **repo root**:

```bash
pnpm install
pnpm build
```

Configure:

```bash
cd packages/daemon
cp towa.example.yaml towa.yaml   # set telegram.chat_id, models, …
cp .env.example .env             # TELEGRAM_BOT_TOKEN=…
```

## CLI

After build, the `towa` bin is available via `pnpm exec towa` (from `packages/daemon`) or a linked install.

```bash
# Foreground daemon (hosts control HTTP on 127.0.0.1:7432 by default)
towa run --config-file ./towa.yaml

# From another terminal:
towa ping
towa status
towa logs                  # stream NDJSON (pipe to pino-pretty if desired)
towa logs --lines 50 --no-follow
towa stop                  # graceful shutdown
```

## Package scripts (dev)

```bash
# Set TOWA_CONFIG_FILE=./towa.yaml in .env (or the environment), then:
pnpm start
pnpm dev   # watch + inspect on 127.0.0.1:11001
```

## Secrets (env only)

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot API token |
| `OPENAI_API_KEY` | if openai-compatible needs a key | Chat and/or embeddings |
| `TELEGRAM_WEBHOOK_SECRET` | if using webhook secret | Maps to Telegraf `secretToken` |
| `TOWA_CONTROL_TOKEN` | no | Bearer token for CLI ↔ control HTTP (or `control.token` in YAML) |
| `TOWA_CONFIG_FILE` | for `pnpm start` / `dev` | Path passed to the same bootstrap as `towa run` |

Everything else (chat id, model ids, debounce, logging path, control port, …) lives in the YAML file — see `towa.example.yaml`.
