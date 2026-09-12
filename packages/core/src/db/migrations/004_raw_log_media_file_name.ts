import type { Kysely } from "kysely";

import { sql } from "kysely";

import type { Database } from "../types.js";

/**
 * Persist original media filename as a real column (documents, audio, …).
 * Mirrors other durable media identity columns — not JSON.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE raw_log ADD COLUMN media_file_name TEXT NULL
  `.execute(db);
}
