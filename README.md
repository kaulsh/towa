# Towa

Telegram-native AI agent harness built around durable long-term memory recall.

## Development

```bash
pnpm -r install
cd packages/daemon
cp towa.example.yaml towa.yaml   # set chat_id / models
cp .env.example .env             # set TELEGRAM_BOT_TOKEN
cd ../..
pnpm dev
```

See [`packages/daemon/README.md`](./packages/daemon/README.md).
