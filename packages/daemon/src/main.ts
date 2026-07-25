/**
 * Towa daemon — configure env/loaders, start harness + drain loop.
 *
 * Bootstrap: dotenv + model load + openDatabase + createTelegram + createHarness.
 * Daemon owns bot callback registration, `processNextExtraction` (composes
 * core KG/queue primitives), and the extraction poll loop. Harness owns
 * debounce / serial queue / late-arrival regenerate; outbound delivery is via
 * onTurnCompleted → telegram.send.
 */

import "dotenv/config";

import pino from "pino";
import { createHarness, Telegram, Sqlite } from "@towa/core";

import { loadConfig, loadModels } from "./config.js";
import { startExtractionDrainLoop } from "./drain-loop.js";

const log = pino({ name: "daemon-main" });

try {
  log.info("bootstrap starting");

  const cfg = loadConfig(process.env);

  log.debug({ config: cfg }, "config loaded");

  const { chatModel, embeddingModel } = await loadModels(cfg);

  const db = await Sqlite({ path: cfg.dbPath });

  const telegram = Telegram(db, {
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
  });

  const harness = createHarness({
    db,
    chatModel,
    embeddingModel,
    systemPrompt: cfg.systemPrompt,
    debounce: {
      idleMs: cfg.debounceIdleMs,
      maxWaitMs: cfg.debounceMaxWaitMs,
    },
    logger: log.child({ component: "harness" }),
  });

  harness.onTurnCompleted(async (result) => {
    for (const out of result.outbound) {
      await telegram.send(result.chatId, out);
    }
  });

  const drain = startExtractionDrainLoop({
    db,
    chatModel,
    embeddingModel,
    logger: log.child({ component: "drain-loop" }),
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    await telegram.stop();
    await harness.stop();
    await drain.stop();
    await db.destroy();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  harness.start();

  await telegram.start((msg) => harness.handleTurn(msg));

  log.info({ chatId: cfg.telegramChatId }, "daemon up");
} catch (err) {
  log.error({ err }, "fatal");
  process.exit(1);
}
