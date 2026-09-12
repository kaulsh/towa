import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";

import { resolveRecentTurns } from "../raw-log/index.js";
import { DEFAULT_SESSION_IDLE_THRESHOLD_SEC, type WorkingContextTurn } from "./types.js";

const DEFAULT_LOAD_LIMIT = 200;

/**
 * Load recent non-deleted raw_log turns for the working-context window (§6).
 * Edit-aware: originals only, tip content resolved (media transcripts included).
 * Newest-first query, returned oldest→newest for session-boundary / trim.
 */
export async function loadRecentWorkingTurns(
  db: Kysely<Database>,
  options: { limit?: number } = {},
): Promise<WorkingContextTurn[]> {
  const limit = options.limit ?? DEFAULT_LOAD_LIMIT;

  const resolved = await resolveRecentTurns(db, limit);

  return resolved.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
  }));
}

export interface BuildWorkingContextOptions {
  /** Max prior turns to keep (newest first), after session boundary (§6). */
  topK: number;
  /**
   * Idle gap (seconds) that resets the buffer rather than sliding.
   * Default: 2 hours (§6).
   */
  sessionIdleThresholdSec?: number;
}

/**
 * Drop the trailing unanswered user run from recent raw_log turns.
 *
 * Inbound messages are persisted before the retrieval/generation turn, so the
 * current burst already sits at the end of `recentTurns`. The harness passes
 * that burst separately as `message` (+ media); keeping it in the working-
 * context window would double-count it in chat history (§6).
 */
export function excludeTrailingUserTurns(
  turns: readonly WorkingContextTurn[],
): WorkingContextTurn[] {
  let i = turns.length;
  while (i > 0 && turns[i - 1]!.role === "user") {
    i -= 1;
  }
  return turns.slice(0, i);
}

/**
 * Build a fixed top-K working-context buffer (§6).
 *
 * Callers should pass turns that already exclude the current unanswered user
 * burst (`excludeTrailingUserTurns`) — that text is supplied separately as
 * the live `message`.
 *
 * - Session boundary: an idle gap beyond the threshold drops earlier turns.
 * - Sliding window: keep the most recent `topK` turns (no token pre-count).
 * - Turns that age out are dropped, not summarized.
 */
export function buildWorkingContext(
  turns: readonly WorkingContextTurn[],
  options: BuildWorkingContextOptions,
): WorkingContextTurn[] {
  if (turns.length === 0 || options.topK <= 0) {
    return [];
  }

  const threshold = options.sessionIdleThresholdSec ?? DEFAULT_SESSION_IDLE_THRESHOLD_SEC;
  const sorted = [...turns].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  const sessionTurns = applySessionBoundary(sorted, threshold);

  if (sessionTurns.length <= options.topK) {
    return sessionTurns;
  }
  return sessionTurns.slice(sessionTurns.length - options.topK);
}

/**
 * Drop turns before the most recent idle gap exceeding the threshold.
 * If no gap qualifies, the full sequence is kept (then top-K trimmed).
 */
export function applySessionBoundary(
  turnsAscending: readonly WorkingContextTurn[],
  idleThresholdSec: number,
): WorkingContextTurn[] {
  if (turnsAscending.length === 0) {
    return [];
  }

  let sessionStartIdx = 0;
  for (let i = 1; i < turnsAscending.length; i++) {
    const prev = turnsAscending[i - 1]!;
    const curr = turnsAscending[i]!;
    if (curr.timestamp - prev.timestamp > idleThresholdSec) {
      sessionStartIdx = i;
    }
  }

  return turnsAscending.slice(sessionStartIdx);
}
