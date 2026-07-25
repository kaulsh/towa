import type { Kysely } from "kysely";

import type { Database, ExtractionStatus } from "../db/types.js";

export interface PendingExtractionRow {
  episodeId: number;
  status: ExtractionStatus;
  updatedAt: number;
}

/**
 * Insert a pending_extraction row with status='pending' on episode close.
 * Idempotent on conflict: if the episode is already queued, leave it alone
 * (re-enqueue of a done/in_progress row is a no-op here — Track D owns resume).
 */
export async function enqueuePendingExtraction(
  db: Kysely<Database>,
  episodeId: number,
): Promise<void> {
  const updatedAt = Math.floor(Date.now() / 1000);

  await db
    .insertInto("pending_extraction")
    .values({
      episode_id: episodeId,
      status: "pending",
      updated_at: updatedAt,
    })
    .onConflict((oc) => oc.column("episode_id").doNothing())
    .execute();
}

/** Queue helpers for the daemon's `processNextExtraction` tick (caller owns the poll loop). */

export async function listPendingExtractions(
  db: Kysely<Database>,
): Promise<PendingExtractionRow[]> {
  const rows = await db
    .selectFrom("pending_extraction")
    .select(["episode_id", "status", "updated_at"])
    .where("status", "=", "pending")
    .orderBy("episode_id", "asc")
    .execute();

  return rows.map(toRow);
}

/**
 * Crash-recovery scan: rows that are still `pending` or were left `in_progress`.
 */
export async function listResumableExtractions(
  db: Kysely<Database>,
): Promise<PendingExtractionRow[]> {
  const rows = await db
    .selectFrom("pending_extraction")
    .select(["episode_id", "status", "updated_at"])
    .where("status", "in", ["pending", "in_progress"])
    .orderBy("episode_id", "asc")
    .execute();

  return rows.map(toRow);
}

export async function getExtractionStatus(
  db: Kysely<Database>,
  episodeId: number,
): Promise<ExtractionStatus | null> {
  const row = await db
    .selectFrom("pending_extraction")
    .select("status")
    .where("episode_id", "=", episodeId)
    .executeTakeFirst();

  return row?.status ?? null;
}

export async function markExtractionInProgress(
  db: Kysely<Database>,
  episodeId: number,
): Promise<void> {
  const updatedAt = Math.floor(Date.now() / 1000);
  await db
    .updateTable("pending_extraction")
    .set({ status: "in_progress", updated_at: updatedAt })
    .where("episode_id", "=", episodeId)
    .execute();
}

export async function markExtractionDone(
  db: Kysely<Database>,
  episodeId: number,
): Promise<void> {
  const updatedAt = Math.floor(Date.now() / 1000);
  await db
    .updateTable("pending_extraction")
    .set({ status: "done", updated_at: updatedAt })
    .where("episode_id", "=", episodeId)
    .execute();
}

function toRow(row: {
  episode_id: number;
  status: ExtractionStatus;
  updated_at: number;
}): PendingExtractionRow {
  return {
    episodeId: row.episode_id,
    status: row.status,
    updatedAt: row.updated_at,
  };
}
