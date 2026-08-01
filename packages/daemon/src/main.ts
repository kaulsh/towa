/**
 * Towa daemon bootstrap — called by `towa run`.
 *
 * Config YAML + secret env → logging → models → DB → telegram → harness →
 * drain → control HTTP. Foreground until SIGINT/SIGTERM or `towa stop`.
 */

import "dotenv/config";

import {
  configureLogging,
  createHarness,
  getLogger,
  listPendingExtractions,
  listResumableExtractions,
  Telegram,
  Sqlite,
} from "@towa/core";

import { loadConfigFromFile, loadModels } from "./config.js";
import { startControlServer } from "./control-server.js";
import { startExtractionDrainLoop } from "./drain-loop.js";
import {
  defaultRuntimeStatePath,
  removeRuntimeState,
  writeRuntimeState,
} from "./runtime-state.js";

export async function runDaemon(configFilePath: string): Promise<void> {
  const cfg = loadConfigFromFile(configFilePath);

  configureLogging({
    filePath: cfg.logging.filePath,
    maxBytes: cfg.logging.maxBytes,
    stdout: cfg.logging.stdout,
  });

  const log = getLogger("daemon-main");
  log.info(
    { configFile: cfg.configFilePath, dbPath: cfg.dbPath },
    "bootstrap starting",
  );

  const { chatModel, embeddingModel } = await loadModels(cfg);

  const db = await Sqlite({ path: cfg.dbPath });

  const telegram = Telegram(db, {
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
    webhook: cfg.telegramWebhook,
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
    sessionIdleThresholdSec: cfg.sessionIdleThresholdSec,
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
    pollIntervalMs: cfg.drainPollIntervalMs,
  });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    try {
      await control.close();
    } catch (err) {
      log.warn({ err }, "control se rver close failed");
    }
    removeRuntimeState(runtimePath);
    await telegram.stop();
    await harness.clear();
    await drain.stop();
    await db.destroy();
    process.exit(0);
  }

  const runtimePath = defaultRuntimeStatePath();

  const control = await startControlServer({
    host: cfg.control.host,
    port: cfg.control.port,
    token: cfg.control.token,
    logPath: cfg.logging.filePath,
    getStatus: async () => {
      const pending = await listPendingExtractions(db);
      const resumable = await listResumableExtractions(db);
      const inProgress = resumable.filter((r) => r.status === "in_progress");
      return {
        ok: true as const,
        uptimeSec: process.uptime(),
        pid: process.pid,
        chatModelId: chatModel.id,
        embeddingModelId: embeddingModel.id,
        telegramMode: cfg.telegramWebhook ? "webhook" : "polling",
        logPath: cfg.logging.filePath,
        drain: {
          pending: pending.length,
          inProgress: inProgress.length,
        },
      };
    },
    onStop: () => shutdown("control-stop"),
  });

  writeRuntimeState(
    {
      pid: process.pid,
      host: control.host,
      port: control.port,
      token: cfg.control.token,
      logPath: cfg.logging.filePath,
      configFilePath: cfg.configFilePath,
      dbPath: cfg.dbPath,
      startedAt: new Date().toISOString(),
    },
    runtimePath,
  );

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await telegram.start((msg) => harness.handleTurn(msg));

  log.info(
    {
      chatId: cfg.telegramChatId,
      control: `${control.host}:${control.port}`,
      runtimeState: runtimePath,
    },
    "daemon up",
  );
}

/** @deprecated Prefer `towa run --config-file`. Kept for package scripts during transition. */
export async function mainFromEnvConfig(): Promise<void> {
  const path = process.env.TOWA_CONFIG_FILE?.trim();
  if (!path) {
    throw new Error(
      "TOWA_CONFIG_FILE is required when starting via package scripts. Prefer: towa run --config-file PATH",
    );
  }
  await runDaemon(path);
}

// Allow `node dist/main.js` when TOWA_CONFIG_FILE is set (dev scripts).
if (
  process.argv[1]?.endsWith("main.js") ||
  process.argv[1]?.endsWith("main.ts")
) {
  const configPath = process.env.TOWA_CONFIG_FILE?.trim();
  if (configPath) {
    runDaemon(configPath).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}
