# Towa

Telegram-native AI agent harness built around durable long-term memory recall. Architecture and decision rationale: [`docs/towa-design.md`](./docs/towa-design.md). Coding conventions: [`CLAUDE.md`](./CLAUDE.md).

## Workspace

```
towa/                          # library package (`import "towa"`)
examples/telegram-daemon/      # runnable Telegram smoke daemon
```

## Build

```bash
pnpm install
pnpm build          # compile library → dist/
pnpm typecheck
```

## Run the Telegram example

```bash
cd examples/telegram-daemon
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, model settings
pnpm start
```

See [`examples/telegram-daemon/README.md`](./examples/telegram-daemon/README.md) for env vars and prerequisites.
