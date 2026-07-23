/**
 * Telegram daemon example — configure env/loaders/adapter, start the harness.
 *
 * Bootstrap only: dotenv + model load + openDatabase + createTelegramAdapter
 * + createHarness. The agent loop lives in `towa` (§6 / §13).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import pino from "pino";
import {
  createHarness,
  createTelegramAdapter,
  loadLocalEmbeddings,
  loadOllama,
  loadOpenAICompatible,
  loadOpenAICompatibleEmbeddings,
  openDatabase,
  type LoadedChatModel,
  type LoadedEmbeddingModel,
} from "towa";

import { loadConfig, type DaemonConfig } from "./config.js";

const log = pino({ name: "telegram-daemon" });

const exampleRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
loadDotenv({ path: resolve(exampleRoot, ".env") });

async function loadModels(
  cfg: DaemonConfig,
): Promise<{ chatModel: LoadedChatModel; embeddingModel: LoadedEmbeddingModel }> {
  log.info(
    {
      chatProvider: cfg.chatProvider,
      chatModel: cfg.chatModel,
      ollamaHost: cfg.ollamaHost ?? "http://127.0.0.1:11434",
    },
    "loading chat model",
  );

  let chatModel: LoadedChatModel;
  if (cfg.chatProvider === "openai-compatible") {
    chatModel = await loadOpenAICompatible({
      model: cfg.chatModel,
      baseURL: cfg.openaiBaseUrl!,
      apiKey: cfg.openaiApiKey,
      contextWindow: cfg.chatContextWindow,
    });
  } else {
    chatModel = await loadOllama({
      model: cfg.chatModel,
      host: cfg.ollamaHost,
      contextWindow: cfg.chatContextWindow,
      logger: log.child({ component: "ollama" }),
    });
  }
  log.info({ chatModel: chatModel.id }, "chat model ready");

  log.info(
    {
      embeddingProvider: cfg.embeddingProvider,
      embeddingModel: cfg.embeddingModel,
    },
    "loading embedding model",
  );

  let embeddingModel: LoadedEmbeddingModel;
  if (cfg.embeddingProvider === "openai-compatible") {
    embeddingModel = await loadOpenAICompatibleEmbeddings({
      model: cfg.embeddingModel,
      baseURL: cfg.openaiBaseUrl!,
      apiKey: cfg.openaiApiKey,
      dimensions: cfg.embeddingDimensions!,
    });
  } else {
    embeddingModel = await loadLocalEmbeddings({
      model: cfg.embeddingModel || undefined,
      dimensions: cfg.embeddingDimensions,
      logger: log.child({ component: "local-embeddings" }),
    });
  }
  log.info(
    { embeddingModel: embeddingModel.id, dimensions: embeddingModel.dimensions },
    "embedding model ready",
  );

  return { chatModel, embeddingModel };
}

async function main(): Promise<void> {
  log.info("bootstrap starting");

  const cfg = loadConfig(process.env);
  
  log.info(
    {
      chatProvider: cfg.chatProvider,
      chatModel: cfg.chatModel,
      embeddingProvider: cfg.embeddingProvider,
      embeddingModel: cfg.embeddingModel,
      dbPath: cfg.dbPath,
      debounceIdleMs: cfg.debounceIdleMs,
      debounceMaxWaitMs: cfg.debounceMaxWaitMs,
      telegramChatId: cfg.telegramChatId,
      // Intentionally omit tokens / API keys.
    },
    "config loaded",
  );

  const { chatModel, embeddingModel } = await loadModels(cfg);

  log.info({ dbPath: cfg.dbPath }, "opening database");
  
  const db = await openDatabase({ path: cfg.dbPath });
  
  log.info({ dbPath: cfg.dbPath }, "database opened");

  log.info({ chatId: cfg.telegramChatId }, "creating Telegram adapter");
  
  const channel = createTelegramAdapter(db, {
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
  });

  log.info("creating harness");
  
  const harness = createHarness({
    db,
    channel,
    chatModel,
    embeddingModel,
    systemPrompt: cfg.systemPrompt,
    debounce: {
      idleMs: cfg.debounceIdleMs,
      maxWaitMs: cfg.debounceMaxWaitMs,
    },
    logger: log.child({ component: "harness" }),
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    await harness.stop();
    await db.destroy();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("starting harness");
  harness.start();
  log.info(
    { chatId: cfg.telegramChatId },
    "harness up — waiting for Telegram connection",
  );
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
