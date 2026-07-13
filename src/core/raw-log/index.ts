import type { Kysely } from "kysely";

import type { Database, RawLogRole } from "../../db/types.js";

export interface AppendRawLogMessageInput {
  timestamp: number;
  role: RawLogRole;
  content: string;
  /** Platform payload — serialized to JSON in source_meta. */
  sourceMeta: unknown;
}

export interface AppendRawLogEditInput {
  /** raw_log.id of the original message this edit references. */
  originalId: number;
  timestamp: number;
  content: string;
  sourceMeta: unknown;
}

export interface AppendRawLogDeleteInput {
  /** raw_log.id of the original message being deleted. */
  originalId: number;
  timestamp: number;
  sourceMeta: unknown;
}

/**
 * Append a new message row. Sync-fast insert — no LLM, no mutation of priors.
 * Returns the new raw_log.id.
 */
export async function appendRawLogMessage(
  db: Kysely<Database>,
  input: AppendRawLogMessageInput,
): Promise<number> {
  const result = await db
    .insertInto("raw_log")
    .values({
      timestamp: input.timestamp,
      role: input.role,
      content: input.content,
      source_meta: JSON.stringify(input.sourceMeta),
      edit_of: null,
      deleted_marker: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return result.id;
}

/**
 * Append an edit event as a new row referencing `originalId` via `edit_of`.
 * Never mutates the original row in place.
 */
export async function appendRawLogEdit(
  db: Kysely<Database>,
  input: AppendRawLogEditInput,
): Promise<number> {
  const original = await db
    .selectFrom("raw_log")
    .select(["id", "role"])
    .where("id", "=", input.originalId)
    .executeTakeFirst();

  if (!original) {
    throw new Error(`appendRawLogEdit: original raw_log id ${input.originalId} not found`);
  }

  const result = await db
    .insertInto("raw_log")
    .values({
      timestamp: input.timestamp,
      role: original.role,
      content: input.content,
      source_meta: JSON.stringify(input.sourceMeta),
      edit_of: input.originalId,
      deleted_marker: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return result.id;
}

/**
 * Append a delete-marker row referencing `originalId`. Never DELETE/UPDATE the original.
 */
export async function appendRawLogDelete(
  db: Kysely<Database>,
  input: AppendRawLogDeleteInput,
): Promise<number> {
  const original = await db
    .selectFrom("raw_log")
    .select(["id", "role", "content"])
    .where("id", "=", input.originalId)
    .executeTakeFirst();

  if (!original) {
    throw new Error(
      `appendRawLogDelete: original raw_log id ${input.originalId} not found`,
    );
  }

  const result = await db
    .insertInto("raw_log")
    .values({
      timestamp: input.timestamp,
      role: original.role,
      content: original.content,
      source_meta: JSON.stringify(input.sourceMeta),
      edit_of: input.originalId,
      deleted_marker: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return result.id;
}
