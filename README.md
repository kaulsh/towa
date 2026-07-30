# Towa

Telegram-native AI agent harness built around durable long-term memory recall. Architecture and decision rationale: [`docs/towa-design.md`](./docs/towa-design.md). Coding conventions: [`CLAUDE.md`](./CLAUDE.md).

## Workspace

```
packages/core/     # @towa/core — harness, DB, models, Telegram runtime, logging
packages/daemon/   # @towa/daemon — Telegram daemon + `towa` CLI bin
evals/             # @towa/evals scaffolding
docs/
```

## Build

```bash
pnpm install
pnpm build          # build packages
pnpm typecheck
```

## Run

```bash
cd packages/daemon
cp towa.example.yaml towa.yaml   # set chat_id / models
cp .env.example .env             # TELEGRAM_BOT_TOKEN=…
pnpm exec towa run --config-file ./towa.yaml
```

Other terminals: `towa ping` / `status` / `logs` / `stop`. See [`packages/daemon/README.md`](./packages/daemon/README.md).
