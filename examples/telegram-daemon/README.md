# Telegram daemon example

Configures and starts the Towa harness against Telegram: env → load models → open DB → `createTelegramAdapter` → `createHarness(...).start()`.

The agent loop (burst debounce, forced retrieval, reply, drain worker) lives in `@towa/core`; the Telegram adapter is `@towa/telegram`. This package only bootstraps.

## Prerequisites

- Node 22+ and pnpm 10
- A Telegram bot token ([@BotFather](https://t.me/BotFather))
- Your private chat id (allow-listed; single eternal chat)
- A chat model endpoint — default is [Ollama](https://ollama.com) with `llama3.1:8b` (or any model you pull)
- First run of local embeddings downloads the ONNX MiniLM model (CPU)

## Setup

From the **repo root**:

```bash
pnpm install
pnpm build
```

Configure the example:

```bash
cd examples/telegram-daemon
cp .env.example .env
# edit .env — at least TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

## Run

From `examples/telegram-daemon` (or `pnpm --filter @towa/telegram-daemon …` at the repo root):

```bash
# one-shot (needs a prior `pnpm build` for @towa/core, @towa/telegram, and this package)
pnpm start

# watch: tsc for @towa/core + @towa/telegram + this example, then node --watch-path on dist/
# inspect listens on 127.0.0.1:11001 — use VS Code "Attach to 11001"
pnpm dev
```

`dev` runs compiled JS with `--enable-source-maps` (not `tsx`), so breakpoints in both the example and the library packages resolve correctly.

## Required env

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot API token |
| `TELEGRAM_CHAT_ID` | yes | Single allow-listed chat id (string/number) |
| `TOWA_DB_PATH` | no | Default `./towa.db` |
| `TOWA_CHAT_PROVIDER` | no | `ollama` (default) or `openai-compatible` |
| `TOWA_CHAT_MODEL` | no | Default `llama3.1:8b` / `gpt-4o-mini` |
| `OLLAMA_HOST` | no | Default `http://127.0.0.1:11434` |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | if openai-compatible | Shared by chat and/or embeddings |
| `TOWA_EMBEDDING_PROVIDER` | no | `local` (default) or `openai-compatible` |
| `TOWA_EMBEDDING_DIMENSIONS` | if openai embeddings | e.g. `1536` |

See `.env.example` for the full list.

## What this configures

1. Env / dotenv
2. Chat + embedding loaders (`@towa/core`)
3. `openDatabase` (+ migrate)
4. `createTelegramAdapter` (`@towa/telegram`, long-polling)
5. `createHarness({ db, channel, chatModel, embeddingModel, … }).start()`
