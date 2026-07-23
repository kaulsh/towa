# Towa

Telegram-native AI agent harness built around durable long-term memory recall. Architecture and decision rationale: [`docs/towa-design.md`](./docs/towa-design.md). Coding conventions: [`CLAUDE.md`](./CLAUDE.md).

## Workspace

```
packages/core/          # @towa/core — harness, DB, models, ChannelAdapter interface
packages/telegram/      # @towa/telegram — Telegram channel adapter
packages/daemon/        # @towa/daemon — stub (product work next)
packages/cli/           # towa — stub CLI binary (product work next)
examples/telegram-daemon/
evals/                  # @towa/evals scaffolding
docs/
```

## Build

```bash
pnpm install
pnpm build          # build packages + examples
pnpm typecheck
```

## Run the Telegram example

```bash
cd examples/telegram-daemon
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, model settings
pnpm start
```

See [`examples/telegram-daemon/README.md`](./examples/telegram-daemon/README.md) for env vars and prerequisites.
