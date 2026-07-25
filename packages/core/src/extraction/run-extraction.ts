import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";
import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../ai/types.js";
import {
  getExtractionStatus,
  markExtractionInProgress,
} from "./queue.js";

import { resolveTurnsForIdRange } from "../raw-log/index.js";

import { commitExtraction } from "./commit.js";
import { prepareEdgeWrites } from "./edges.js";
import { resolveEntities } from "./entity-resolution.js";
import { extractEpisodeKnowledge } from "./extract.js";
import { clearEpisodeExtractionArtifacts } from "./idempotency.js";
import { enrichTurnsWithMedia, persistMediaTextArtifacts } from "./media.js";
import type { EpisodeTurn } from "./types.js";

export interface RunExtractionDeps {
  db: Kysely<Database>;
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
}

/**
 * Extract KG + gist for one episode (§4).
 *
 * Sequence: check status → mark in_progress → clear prior KG artifacts →
 * edit-aware load turns → media enrich + persist text artifacts + LLM extract
 * + entity resolve + embed (all outside the final KG write txn) → one short
 * txn for nodes/edges/gist/done.
 */
export async function runExtraction(
  episodeId: number,
  deps: RunExtractionDeps,
): Promise<void> {
  const { db, chatModel, embeddingModel } = deps;

  const status = await getExtractionStatus(db, episodeId);
  if (status === null) {
    throw new Error(
      `runExtraction: no pending_extraction row for episode ${episodeId}`,
    );
  }
  if (status === "done") {
    // Already finished — idempotent no-op.
    return;
  }

  await markExtractionInProgress(db, episodeId);

  // Drop any partial KG writes from a prior crashed attempt before re-extracting.
  // Media text edits stay append-only; persistMediaTextArtifacts skips identical tips.
  await clearEpisodeExtractionArtifacts(db, episodeId);

  const episode = await db
    .selectFrom("episodes")
    .select(["id", "start_msg_id", "end_msg_id", "closed_at"])
    .where("id", "=", episodeId)
    .executeTakeFirst();

  if (!episode) {
    throw new Error(`runExtraction: episode ${episodeId} not found`);
  }

  // Edit-aware: media_artifact rows land outside [start, end] after close.
  const resolvedTurns = await resolveTurnsForIdRange(
    db,
    episode.start_msg_id,
    episode.end_msg_id,
  );

  // Enrich from wire/user caption (not a prior media_artifact tip) so re-runs
  // replace the artifact instead of double-appending.
  const turnsForEnrich: EpisodeTurn[] = resolvedTurns.map((t) => ({
    rawLogId: t.id,
    timestamp: t.timestamp,
    role: t.role,
    content: t.wireContent,
    messageId: t.messageId ?? "",
    ...(t.media ? { media: t.media } : {}),
  }));

  // --- Slow work: no open write transaction (§4.2) ---

  const enrichedTurns = await enrichTurnsWithMedia(turnsForEnrich, chatModel);

  // Short isolated writes — before the extract LLM, still outside KG txn.
  await persistMediaTextArtifacts(db, resolvedTurns, enrichedTurns);

  const extraction = await extractEpisodeKnowledge(
    chatModel,
    enrichedTurns,
    episode.closed_at,
  );

  // Gist is unconditional — schema requires it; embed regardless of KG yield.
  const [gistEmbedding] = await embeddingModel.embed([extraction.gist]);

  const { resolved, newNodes } = await resolveEntities(
    db,
    chatModel,
    embeddingModel,
    extraction.entities,
    episodeId,
  );

  const ingestedAt = Math.floor(Date.now() / 1000);
  const edgeWrites = await prepareEdgeWrites(
    db,
    extraction.edges,
    resolved,
    episodeId,
    episode.closed_at,
    ingestedAt,
  );

  // --- Short final write transaction ---
  await commitExtraction(db, {
    episodeId,
    newNodes,
    edges: edgeWrites,
    gistText: extraction.gist,
    gistEmbedding: gistEmbedding ?? [],
  });
}
