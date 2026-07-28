# Towa daemon (`@towa/daemon`)

Configures and starts the Towa harness against Telegram: env → load models → open DB → `createTelegram` → `createHarness` → `onTurnCompleted` → extraction drain loop (`processNextExtraction` composing core KG/queue) → `harness.start()` → `telegram.start((msg) => harness.handleTurn(msg))`.

The daemon owns bot callback registration, `processNextExtraction` (imports `runExtraction` / `listResumableExtractions` from `@towa/core`), and the extraction poll loop — no media port. Core stays library-like and does not start workers. The harness owns debounce / serial queue / late-arrival regenerate and emits outbound via `onTurnCompleted`; it does not inject `send` or start the drain. Inbound media bytes live in a process-local cache for drain enrichment (§7.3).

Includes a stub `towa` CLI binary; product CLI commands are not implemented yet. Run the daemon via package scripts below.

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
cp .env.example .env
# edit .env — at least TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

## Run (daemon, without CLI)

From `packages/daemon` (or `pnpm --filter @towa/daemon …` at the repo root):

```bash
# one-shot (needs a prior `pnpm build` for @towa/core and this package)
pnpm start

# watch: tsc for @towa/core + this package, then node --watch-path on dist/
# inspect listens on 127.0.0.1:11001 — use VS Code "Attach to 11001"
pnpm dev
```

`dev` runs compiled JS with `--enable-source-maps` (not `tsx`), so breakpoints in both the daemon and `@towa/core` resolve correctly.

## Required env

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot API token |
| `TELEGRAM_CHAT_ID` | yes | Single allow-listed chat id (string/number) |
| `TOWA_DB_PATH` | no | Default `./towa.db` |
| `TOWA_CHAT_PROVIDER` | no | `ollama` (default) or `openai-compatible` |
| `TOWA_CHAT_MODEL` | no | Default `llama3.1:8b` / `gpt-4o-mini` |
| `TOWA_CHAT_VISION` | no | `true` to enable image multimodal generate (Ollama `messages[].images`) |
| `TOWA_CHAT_AUDIO_INPUT` | no | `true` to enable audio multimodal generate |
| `OLLAMA_HOST` | no | Default `http://127.0.0.1:11434` |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | if openai-compatible | Shared by chat and/or embeddings |
| `TOWA_EMBEDDING_PROVIDER` | no | `local` (default) or `openai-compatible` |
| `TOWA_EMBEDDING_DIMENSIONS` | if openai embeddings | e.g. `1536` |

See `.env.example` for the full list.
