import { getLogger } from "@towa/core";

import {
  processNextExtraction,
  type ProcessNextExtractionDeps,
} from "./process-next-extraction.js";

export interface ExtractionDrainLoopOptions extends ProcessNextExtractionDeps {
  /** Poll interval when the queue is idle. Default 1000ms. */
  pollIntervalMs?: number;
}

export interface ExtractionDrainLoopHandle {
  /** Stop the poll loop after the current episode (if any) finishes. */
  stop(): Promise<void>;
}

/**
 * Daemon-owned extraction poll loop (§4.2).
 * Repeatedly calls local `processNextExtraction`, which composes core's
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
