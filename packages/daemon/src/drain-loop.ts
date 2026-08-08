import {
  listResumableExtractions,
  runExtraction,
  getLogger,
  type RunExtractionDeps,
} from "@towa/core";

export interface ExtractionDrainLoopOptions extends RunExtractionDeps {
  /** Poll interval when the queue is idle. Default 1000ms. */
  pollIntervalMs?: number;
}

export interface ExtractionDrainLoopHandle {
  /** Stop the poll loop after the current episode (if any) finishes. */
  stop(): Promise<void>;
}

/**
 * Claim at most one pending episode, run extraction end-to-end, update queue status.
 * Returns whether work was performed. Caller owns scheduling/polling/shutdown.
 *
 * Daemon-owned tick that composes core KG/queue primitives (§4.2). On success:
 * episode is marked `done` inside `runExtraction`. On failure: status stays
 * `pending`/`in_progress` for a later retry and the error is rethrown so the
 * caller can back off. No LLM work runs inside an open SQLite write transaction.
 */
async function processNextExtraction(
  deps: RunExtractionDeps,
): Promise<"worked" | "idle"> {
  const { db, chatModel, embeddingModel } = deps;
  const log = getLogger("process-next-extraction");

  const batch = await listResumableExtractions(db);
  const row = batch[0];
  if (!row) {
    return "idle";
  }

  log.info(
    { episodeId: row.episodeId, status: row.status },
    "extracting episode",
  );

  try {
    await runExtraction(row.episodeId, {
      db,
      chatModel,
      embeddingModel,
    });
    log.info({ episodeId: row.episodeId }, "extraction done");
    return "worked";
  } catch (err) {
    log.error(
      { err, episodeId: row.episodeId },
      "extraction failed; leaving status for retry",
    );
    throw err;
  }
}

/**
 * Daemon-owned extraction poll loop (§4.2).
 * Repeatedly calls `processNextExtraction`, which composes core's
 * `runExtraction` + queue helpers; does not own KG write logic itself.
 */
export function startExtractionDrainLoop(
  options: ExtractionDrainLoopOptions,
): ExtractionDrainLoopHandle {
  const { db, chatModel, embeddingModel, pollIntervalMs = 1000 } = options;
  const log = getLogger("drain-loop");

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
    let consecutiveFailures = 0;

    while (!stopped) {
      try {
        const result = await processNextExtraction({
          db,
          chatModel,
          embeddingModel,
        });

        if (result === "idle") {
          consecutiveFailures = 0;
          await sleepOrWake(pollIntervalMs);
          continue;
        }

        // Worked — immediately try another episode (no idle sleep).
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        log.error({ err }, "extraction drain poll error");
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
