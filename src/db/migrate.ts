import type { Kysely } from "kysely";

import { up as up001 } from "./migrations/001_initial.js";
import { up as up002 } from "./migrations/002_init_interview.js";
import type { Database } from "./types.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: Kysely<Database>) => Promise<void>;
}

/** Ordered migration scripts. Append new entries; never reorder or renumber. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "001_initial", up: up001 },
  { version: 2, name: "002_init_interview", up: up002 },
];

/**
 * Run pending migrations against `schema_version` (§10).
 * Safe to call on every startup — already-applied versions are skipped.
 */
export async function migrate(db: Kysely<Database>): Promise<void> {
  const tables = await db.introspection.getTables();
  const hasVersionTable = tables.some((t) => t.name === "schema_version");

  let current = 0;
  if (hasVersionTable) {
    const row = await db
      .selectFrom("schema_version")
      .select(({ fn }) => fn.max("version").as("max_version"))
      .executeTakeFirst();
    current = row?.max_version ?? 0;
  }

  const now = Math.floor(Date.now() / 1000);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    await migration.up(db);

    // schema_version is created by 001 itself — insert after up succeeds.
    await db
      .insertInto("schema_version")
      .values({ version: migration.version, applied_at: now })
      .execute();
  }
}
