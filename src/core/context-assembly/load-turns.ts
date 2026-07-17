import type { Kysely } from "kysely";

import type { Database } from "../../db/types.js";

import type { WorkingContextTurn } from "./types.js";

const DEFAULT_LIMIT = 200;

/**
 * Load recent non-deleted raw_log turns for the working-context window (§6).
 * Newest-first query, returned oldest→newest for session-boundary / trim.
 */
export async function loadRecentWorkingTurns(
  db: Kysely<Database>,
  options: { limit?: number } = {},
): Promise<WorkingContextTurn[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const rows = await db
    .selectFrom("raw_log")
    .select(["id", "role", "content", "timestamp"])
    .where("deleted_marker", "=", 0)
    .orderBy("id", "desc")
    .limit(limit)
    .execute();

  return rows
    .reverse()
    .map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
    }));
}
