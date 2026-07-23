import type { Kysely } from "kysely";
import pino, { type Logger } from "pino";

import type { ChannelAdapter } from "../../channels/adapter.js";
import type { Database } from "../../db/types.js";
import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../../models/types.js";
import { runExtraction } from "../kg/run-extraction.js";
import { listResumableExtractions } from "./queue.js";

export interface DrainWorkerOptions {
  db: Kysely<Database>;
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
  adapter: ChannelAdapter;
  /** Poll interval when the queue is idle. Default 1000ms. */
  pollIntervalMs?: number;
  logger?: Logger;
}

export interface DrainWorkerHandle {
  /** Stop the poll loop after the current episode (if any) finishes. */
  stop(): Promise<void>;
}

/**
 * Async extraction drain worker (§4.2).
 * Runs inside the same daemon process — polls pending_extraction, resumes
 * in_progress rows on startup, and calls runExtraction per episode.
 */
export function startDrainWorker(options: DrainWorkerOptions): DrainWorkerHandle {
  const {
    db,
    chatModel,
    embeddingModel,
    adapter,
    pollIntervalMs = 1000,
  } = options;
  const log = options.logger ?? pino({ name: "drain-worker" });

  let stopped = false;
  let wake: (() => void) | null = null;
  let running: Promise<void> | null = null;

  const sleepOrWake = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const loop = async (): Promise<void> => {
    // Always scan pending + in_progress (§4.2 crash recovery + mid-run failures).
    let consecutiveFailures = 0;

    while (!stopped) {
      try {
        const batch = await listResumableExtractions(db);

        if (batch.length === 0) {
          consecutiveFailures = 0;
          await sleepOrWake(pollIntervalMs);
          continue;
        }

        for (const row of batch) {
          if (stopped) break;
          log.info(
            { episodeId: row.episodeId, status: row.status },
            "extracting episode",
          );
          try {
            await runExtraction(row.episodeId, {
              db,
              chatModel,
              embeddingModel,
              adapter,
            });
            consecutiveFailures = 0;
            log.info({ episodeId: row.episodeId }, "extraction done");
          } catch (err) {
            consecutiveFailures += 1;
            log.error(
              { err, episodeId: row.episodeId },
              "extraction failed; leaving status for retry",
            );
            // Leave status as in_progress so the next poll can retry.
            // Back off to avoid a hot loop on persistent failures.
            await sleepOrWake(
              pollIntervalMs * Math.min(consecutiveFailures, 10),
            );
          }
        }
      } catch (err) {
        consecutiveFailures += 1;
        log.error({ err }, "drain worker poll error");
        await sleepOrWake(pollIntervalMs * Math.min(consecutiveFailures, 10));
      }
    }
  };

  running = loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      wake?.();
      await running;
    },
  };
}

/**
 * Process currently resumable queue rows once (no polling loop).
 * Useful for tests and one-shot drain after enqueue.
 */
export async function drainOnce(options: Omit<DrainWorkerOptions, "pollIntervalMs">): Promise<void> {
  const { db, chatModel, embeddingModel, adapter } = options;
  const log = options.logger ?? pino({ name: "drain-worker" });
  const batch = await listResumableExtractions(db);
  for (const row of batch) {
    log.info({ episodeId: row.episodeId, status: row.status }, "extracting episode");
    await runExtraction(row.episodeId, {
      db,
      chatModel,
      embeddingModel,
      adapter,
    });
  }
}
