import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";
import { resolveRecentTurns } from "../raw-log/index.js";

import type { WorkingContextTurn } from "./types.js";

const DEFAULT_LIMIT = 200;

/**
 * Load recent non-deleted raw_log turns for the working-context window (§6).
 * Edit-aware: originals only, tip content resolved (media transcripts included).
 * Newest-first query, returned oldest→newest for session-boundary / trim.
 */
export async function loadRecentWorkingTurns(
  db: Kysely<Database>,
  options: { limit?: number } = {},
): Promise<WorkingContextTurn[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const resolved = await resolveRecentTurns(db, limit);

  return resolved.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
  }));
}
