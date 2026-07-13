import DatabaseConstructor from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import * as sqliteVec from "sqlite-vec";

import { migrate } from "./migrate.js";
import type { Database } from "./types.js";

export type { Database } from "./types.js";
export { VALID_TO_OPEN_SENTINEL } from "./constants.js";
export { migrate } from "./migrate.js";

export interface OpenDatabaseOptions {
  /** Filesystem path, or `:memory:` for tests. */
  path: string;
  /** Skip running migrations (rare; default false). */
  skipMigrate?: boolean;
}

/**
 * Open a SQLite connection with WAL mode, busy_timeout, and sqlite-vec loaded,
 * then run ordered migrations. This is the single entry point every track uses
 * to obtain a typed Kysely instance.
 */
export async function openDatabase(
  options: OpenDatabaseOptions,
): Promise<Kysely<Database>> {
  const sqlite = new DatabaseConstructor(options.path);

  // Concurrency: readers never block writers (WAL); contention waits briefly.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");

  // Design doc §3: load sqlite-vec via better-sqlite3's loadExtension path.
  sqliteVec.load(sqlite);

  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });

  if (!options.skipMigrate) {
    await migrate(db);
  }

  return db;
}
