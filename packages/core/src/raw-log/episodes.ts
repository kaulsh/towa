import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";

export interface EpisodeBoundary {
  startMsgId: number;
  endMsgId: number;
}

/**
 * Derive the episode boundary closed by an assistant message (§2.2).
 *
 * episode = run of consecutive user messages since the last assistant message,
 * plus the assistant reply that closes it.
 *
 * Pure derivation from the raw log — does not write. Returns null if
 * `closingAssistantMsgId` is missing or is not an assistant row.
 */
export async function deriveEpisodeBoundary(
  db: Kysely<Database>,
  closingAssistantMsgId: number,
): Promise<EpisodeBoundary | null> {
  const closing = await db
    .selectFrom("raw_log")
    .select(["id", "role"])
    .where("id", "=", closingAssistantMsgId)
    .executeTakeFirst();

  if (!closing || closing.role !== "assistant") {
    return null;
  }

  const previousAssistant = await db
    .selectFrom("raw_log")
    .select("id")
    .where("role", "=", "assistant")
    .where("id", "<", closingAssistantMsgId)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();

  let startMsgId: number;
  if (previousAssistant) {
    startMsgId = previousAssistant.id + 1;
  } else {
    const first = await db
      .selectFrom("raw_log")
      .select("id")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    startMsgId = first?.id ?? closingAssistantMsgId;
  }

  if (startMsgId > closingAssistantMsgId) {
    return null;
  }

  return { startMsgId, endMsgId: closingAssistantMsgId };
}

export interface CloseEpisodeInput {
  startMsgId: number;
  endMsgId: number;
  /** Unix epoch seconds; defaults to now. */
  closedAt?: number;
}

/**
 * Persist an episode row once its boundary has closed (assistant reply sent).
 * Returns the new episodes.id. Caller is responsible for enqueueing extraction.
 */
export async function closeEpisode(
  db: Kysely<Database>,
  input: CloseEpisodeInput,
): Promise<number> {
  const closedAt = input.closedAt ?? Math.floor(Date.now() / 1000);

  const result = await db
    .insertInto("episodes")
    .values({
      start_msg_id: input.startMsgId,
      end_msg_id: input.endMsgId,
      closed_at: closedAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return result.id;
}
