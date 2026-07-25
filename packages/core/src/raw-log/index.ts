import type { Kysely } from "kysely";

import type { MediaKind } from "../messages.js";
import type { Database, RawLogRole, SqliteBoolean } from "../db/types.js";
import {
  deleteFtsBySource,
  indexRawLogForFts,
} from "../retrieval/fts-index.js";

export {
  mediaRefFromColumns,
  resolveLatestContent,
  resolveRecentTurns,
  resolveTurnsForIdRange,
} from "./resolve-turns.js";
export type { ResolvedTurn } from "./resolve-turns.js";

export interface AppendRawLogMedia {
  fileId: string;
  mimeType: string;
  kind: MediaKind;
}

export interface AppendRawLogMessageInput {
  timestamp: number;
  role: RawLogRole;
  content: string;
  chatId: string | null;
  messageId: string | null;
  media?: AppendRawLogMedia | null;
}

export interface AppendRawLogEditInput {
  /** raw_log.id of the original message this edit references. */
  originalId: number;
  timestamp: number;
  content: string;
  chatId?: string | null;
  messageId?: string | null;
  media?: AppendRawLogMedia | null;
  /** System transcript/caption edit (§7.3) — excluded from wireContent. */
  isMediaArtifact?: boolean;
}

export interface AppendRawLogDeleteInput {
  /** raw_log.id of the original message being deleted. */
  originalId: number;
  timestamp: number;
  chatId?: string | null;
  messageId?: string | null;
}

function mediaColumns(media: AppendRawLogMedia | null | undefined): {
  media_file_id: string | null;
  media_mime_type: string | null;
  media_kind: MediaKind | null;
} {
  if (!media) {
    return {
      media_file_id: null,
      media_mime_type: null,
      media_kind: null,
    };
  }
  return {
    media_file_id: media.fileId,
    media_mime_type: media.mimeType,
    media_kind: media.kind,
  };
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
      chat_id: input.chatId,
      message_id: input.messageId,
      ...mediaColumns(input.media),
      is_media_artifact: 0 as SqliteBoolean,
      edit_of: null,
      deleted_marker: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Lexical index must stay current for forced retrieval (§5.2).
  await indexRawLogForFts(db, result.id, input.content);

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
    .select([
      "id",
      "role",
      "chat_id",
      "message_id",
      "media_file_id",
      "media_mime_type",
      "media_kind",
    ])
    .where("id", "=", input.originalId)
    .executeTakeFirst();

  if (!original) {
    throw new Error(`appendRawLogEdit: original raw_log id ${input.originalId} not found`);
  }

  const media =
    input.media ??
    (original.media_file_id &&
    original.media_mime_type &&
    original.media_kind
      ? {
          fileId: original.media_file_id,
          mimeType: original.media_mime_type,
          kind: original.media_kind,
        }
      : null);

  const result = await db
    .insertInto("raw_log")
    .values({
      timestamp: input.timestamp,
      role: original.role,
      content: input.content,
      chat_id: input.chatId ?? original.chat_id,
      message_id: input.messageId ?? original.message_id,
      ...mediaColumns(media),
      is_media_artifact: (input.isMediaArtifact ? 1 : 0) as SqliteBoolean,
      edit_of: input.originalId,
      deleted_marker: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Keep searchable text on the original id (edits are append-only rows).
  await indexRawLogForFts(db, input.originalId, input.content);

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
    .select([
      "id",
      "role",
      "content",
      "chat_id",
      "message_id",
      "media_file_id",
      "media_mime_type",
      "media_kind",
    ])
    .where("id", "=", input.originalId)
    .executeTakeFirst();

  if (!original) {
    throw new Error(
      `appendRawLogDelete: original raw_log id ${input.originalId} not found`,
    );
  }

  const media =
    original.media_file_id &&
    original.media_mime_type &&
    original.media_kind
      ? {
          fileId: original.media_file_id,
          mimeType: original.media_mime_type,
          kind: original.media_kind,
        }
      : null;

  const result = await db
    .insertInto("raw_log")
    .values({
      timestamp: input.timestamp,
      role: original.role,
      content: original.content,
      chat_id: input.chatId ?? original.chat_id,
      message_id: input.messageId ?? original.message_id,
      ...mediaColumns(media),
      is_media_artifact: 0 as SqliteBoolean,
      edit_of: input.originalId,
      deleted_marker: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await deleteFtsBySource(db, "raw_log", String(input.originalId));

  return result.id;
}
