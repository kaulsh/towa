import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod";

import { isMediaKind, type MediaKind } from "../../messages.js";
import type { Database } from "../types.js";

const MediaRefBackfillSchema = z.object({
  fileId: z.string().optional(),
  platformFileId: z.string().optional(),
  platform_file_id: z.string().optional(),
  mimeType: z.string().optional(),
  mime_type: z.string().optional(),
  kind: z.string().optional(),
});

const PhotoSizeSchema = z.object({
  file_id: z.string(),
});

const FileLikeSchema = z.object({
  file_id: z.string(),
  mime_type: z.string().optional(),
});

/**
 * Legacy source_meta shapes we may encounter during one-time backfill.
 * Validated with Zod at the JSON boundary — not used at runtime after drop.
 */
const SourceMetaBackfillSchema = z
  .object({
    message_id: z.union([z.number(), z.string()]).optional(),
    chat: z
      .object({
        id: z.union([z.number(), z.string()]),
      })
      .optional(),
    mediaRef: MediaRefBackfillSchema.optional(),
    media_ref: MediaRefBackfillSchema.optional(),
    kind: z.string().optional(),
    photo: z.array(PhotoSizeSchema).optional(),
    video: FileLikeSchema.optional(),
    voice: FileLikeSchema.optional(),
    audio: FileLikeSchema.optional(),
    video_note: z.object({ file_id: z.string() }).optional(),
    document: FileLikeSchema.optional(),
  })
  .passthrough();

interface BackfillMedia {
  fileId: string;
  mimeType: string;
  kind: MediaKind;
}

function mediaFromRefObject(
  ref: z.infer<typeof MediaRefBackfillSchema>,
): BackfillMedia | null {
  const fileId = ref.fileId ?? ref.platformFileId ?? ref.platform_file_id;
  const mimeType = ref.mimeType ?? ref.mime_type;
  const kind = ref.kind;
  if (
    typeof fileId !== "string" ||
    typeof mimeType !== "string" ||
    typeof kind !== "string" ||
    !isMediaKind(kind)
  ) {
    return null;
  }
  return { fileId, mimeType, kind };
}

function mediaFromTelegramShapes(
  meta: z.infer<typeof SourceMetaBackfillSchema>,
): BackfillMedia | null {
  if (meta.photo && meta.photo.length > 0) {
    const largest = meta.photo[meta.photo.length - 1]!;
    return {
      fileId: largest.file_id,
      mimeType: "image/jpeg",
      kind: "image",
    };
  }
  if (meta.video) {
    return {
      fileId: meta.video.file_id,
      mimeType: meta.video.mime_type ?? "video/mp4",
      kind: "video",
    };
  }
  if (meta.voice) {
    return {
      fileId: meta.voice.file_id,
      mimeType: meta.voice.mime_type ?? "audio/ogg",
      kind: "audio",
    };
  }
  if (meta.audio) {
    return {
      fileId: meta.audio.file_id,
      mimeType: meta.audio.mime_type ?? "audio/mpeg",
      kind: "audio",
    };
  }
  if (meta.video_note) {
    return {
      fileId: meta.video_note.file_id,
      mimeType: "video/mp4",
      kind: "video",
    };
  }
  if (meta.document) {
    return {
      fileId: meta.document.file_id,
      mimeType: meta.document.mime_type ?? "application/octet-stream",
      kind: "file",
    };
  }
  return null;
}

function parseSourceMeta(raw: string): z.infer<typeof SourceMetaBackfillSchema> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = SourceMetaBackfillSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Promote durable media + message identity out of source_meta JSON into real
 * columns, then drop source_meta. Edit lookup becomes (chat_id, message_id).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE raw_log ADD COLUMN chat_id TEXT NULL
  `.execute(db);
  await sql`
    ALTER TABLE raw_log ADD COLUMN message_id TEXT NULL
  `.execute(db);
  await sql`
    ALTER TABLE raw_log ADD COLUMN media_file_id TEXT NULL
  `.execute(db);
  await sql`
    ALTER TABLE raw_log ADD COLUMN media_mime_type TEXT NULL
  `.execute(db);
  await sql`
    ALTER TABLE raw_log ADD COLUMN media_kind TEXT NULL
  `.execute(db);
  await sql`
    ALTER TABLE raw_log ADD COLUMN is_media_artifact INTEGER NOT NULL DEFAULT 0
  `.execute(db);

  const rows = await sql<{ id: number; source_meta: string }>`
    SELECT id, source_meta FROM raw_log
  `.execute(db);

  for (const row of rows.rows) {
    const meta = parseSourceMeta(row.source_meta);
    if (!meta) {
      continue;
    }

    const chatId =
      meta.chat?.id !== undefined ? String(meta.chat.id) : null;
    const messageId =
      meta.message_id !== undefined ? String(meta.message_id) : null;
    const isMediaArtifact = meta.kind === "media_artifact" ? 1 : 0;

    const fromRef =
      (meta.mediaRef ? mediaFromRefObject(meta.mediaRef) : null) ??
      (meta.media_ref ? mediaFromRefObject(meta.media_ref) : null);
    const media = fromRef ?? mediaFromTelegramShapes(meta);

    await sql`
      UPDATE raw_log SET
        chat_id = ${chatId},
        message_id = ${messageId},
        media_file_id = ${media?.fileId ?? null},
        media_mime_type = ${media?.mimeType ?? null},
        media_kind = ${media?.kind ?? null},
        is_media_artifact = ${isMediaArtifact}
      WHERE id = ${row.id}
    `.execute(db);
  }

  await sql`
    CREATE INDEX IF NOT EXISTS raw_log_chat_message
      ON raw_log (chat_id, message_id)
      WHERE edit_of IS NULL AND deleted_marker = 0
  `.execute(db);

  await sql`
    ALTER TABLE raw_log DROP COLUMN source_meta
  `.execute(db);
}
