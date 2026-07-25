import {
  listResumableExtractions,
  runExtraction,
  type CreateHarnessDeps,
} from "@towa/core";
import pino, { type Logger } from "pino";

export type ProcessNextExtractionDeps = Pick<
  CreateHarnessDeps,
  "db" | "chatModel" | "embeddingModel"
> & {
  logger?: Logger;
};

/**
 * Claim at most one pending episode, run extraction end-to-end, update queue status.
 * Returns whether work was performed. Caller owns scheduling/polling/shutdown.
 *
 * Daemon-owned tick that composes core KG/queue primitives (§4.2). On success:
 * episode is marked `done` inside `runExtraction`. On failure: status stays
 * `pending`/`in_progress` for a later retry and the error is rethrown so the
 * caller can back off. No LLM work runs inside an open SQLite write transaction.
 */
export async function processNextExtraction(
  deps: ProcessNextExtractionDeps,
): Promise<"worked" | "idle"> {
  const { db, chatModel, embeddingModel } = deps;
  const log = deps.logger ?? pino({ name: "process-next-extraction" });

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
