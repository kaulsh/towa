import type { Kysely } from "kysely";

import { sql } from "kysely";

import type { Database } from "../types.js";

/**
 * Per-chat adaptive `/init` interview state (§6 slash-command intercept).
 * Goal id lists are JSON arrays stored as TEXT.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE init_interview (
      chat_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('idle', 'active', 'completed')),
      turn_count INTEGER NOT NULL DEFAULT 0,
      resolved_goals TEXT NOT NULL DEFAULT '[]',
      pending_goals TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )
  `.execute(db);
}
