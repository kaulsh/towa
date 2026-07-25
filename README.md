# Towa

Telegram-native AI agent harness built around durable long-term memory recall. Architecture and decision rationale: [`docs/towa-design.md`](./docs/towa-design.md). Coding conventions: [`CLAUDE.md`](./CLAUDE.md).

## Workspace

```
packages/core/     # @towa/core — harness, DB, models, Telegram runtime
packages/daemon/   # @towa/daemon — Telegram daemon + stub `towa` CLI bin
evals/             # @towa/evals scaffolding
docs/
```

## Build

```bash
pnpm install
pnpm build          # build packages
pnpm typecheck
```

## Run the Telegram daemon

```bash
cd packages/daemon
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, model settings
pnpm start             # or: pnpm dev (watch + inspect on 127.0.0.1:11001)
```

See [`packages/daemon/README.md`](./packages/daemon/README.md) for env vars and prerequisites.
