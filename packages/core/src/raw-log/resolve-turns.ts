import type { Kysely } from "kysely";

import type { MediaKind, MediaRef } from "../messages.js";
import type { Database, RawLogRole, SqliteBoolean } from "../db/types.js";

/** Build a durable MediaRef from raw_log media columns (no `data`). */
export function mediaRefFromColumns(
  fileId: string | null,
  mimeType: string | null,
  kind: MediaKind | null,
): MediaRef | undefined {
  if (!fileId || !mimeType || !kind) {
    return undefined;
  }
  return { fileId, mimeType, kind };
}

/**
 * One logical turn after edit-aware resolution (§2.1 / Track F).
 *
 * `id` is always the original raw_log id (never an edit row id). Edit rows
 * that fall outside episode `[start_msg_id, end_msg_id]` are folded in via
 * `edit_of` so verbatim loaders still see durable media transcripts.
 */
export interface ResolvedTurn {
  id: number;
  timestamp: number;
  role: RawLogRole;
  /** Latest non-deleted tip content (original, user edit, or media_artifact). */
  content: string;
  /**
   * Latest content that is not a system media_artifact edit — the wire /
   * user-facing caption base used when re-running media enrichment.
   */
  wireContent: string;
  chatId: string | null;
  messageId: string | null;
  /** Durable media from the original row columns (no bytes). */
  media?: MediaRef;
}

interface RawRow {
  id: number;
  timestamp: number;
  role: RawLogRole;
  content: string;
  chat_id: string | null;
  message_id: string | null;
  media_file_id: string | null;
  media_mime_type: string | null;
  media_kind: MediaKind | null;
  is_media_artifact: SqliteBoolean;
  edit_of: number | null;
  deleted_marker: SqliteBoolean;
}

const RAW_LOG_SELECT = [
  "id",
  "timestamp",
  "role",
  "content",
  "chat_id",
  "message_id",
  "media_file_id",
  "media_mime_type",
  "media_kind",
  "is_media_artifact",
  "edit_of",
  "deleted_marker",
] as const;

/**
 * Resolve the latest content for each original id.
 * Missing / deleted originals are omitted from the result map.
 */
export async function resolveLatestContent(
  db: Kysely<Database>,
  originalIds: readonly number[],
): Promise<Map<number, ResolvedTurn>> {
  const unique = [...new Set(originalIds)].filter((id) => id > 0);
  if (unique.length === 0) {
    return new Map();
  }

  const originals = await db
    .selectFrom("raw_log")
    .select([...RAW_LOG_SELECT])
    .where("id", "in", unique)
    .where("edit_of", "is", null)
    .execute();

  const edits = await db
    .selectFrom("raw_log")
    .select([...RAW_LOG_SELECT])
    .where("edit_of", "in", unique)
    .orderBy("id", "asc")
    .execute();

  const editsByOriginal = new Map<number, RawRow[]>();
  for (const row of edits) {
    if (row.edit_of === null) {
      continue;
    }
    const list = editsByOriginal.get(row.edit_of) ?? [];
    list.push(row);
    editsByOriginal.set(row.edit_of, list);
  }

  const out = new Map<number, ResolvedTurn>();
  for (const original of originals) {
    const resolved = resolveOne(original, editsByOriginal.get(original.id) ?? []);
    if (resolved) {
      out.set(original.id, resolved);
    }
  }
  return out;
}

/**
 * Load originals in `[startId, endId]` and fold in later edits (including
 * media_artifact rows whose ids fall outside the episode range).
 * Edit rows themselves are never emitted as separate turns.
 */
export async function resolveTurnsForIdRange(
  db: Kysely<Database>,
  startId: number,
  endId: number,
): Promise<ResolvedTurn[]> {
  if (endId < startId) {
    return [];
  }

  const originals = await db
    .selectFrom("raw_log")
    .select([...RAW_LOG_SELECT])
    .where("id", ">=", startId)
    .where("id", "<=", endId)
    .where("edit_of", "is", null)
    .orderBy("id", "asc")
    .execute();

  if (originals.length === 0) {
    return [];
  }

  const ids = originals.map((r) => r.id);
  const resolved = await resolveLatestContent(db, ids);

  const turns: ResolvedTurn[] = [];
  for (const original of originals) {
    const turn = resolved.get(original.id);
    if (turn) {
      turns.push(turn);
    }
  }
  return turns;
}

/**
 * Recent logical turns for the working-context window: originals only,
 * newest-first query, returned oldest→newest with tip content resolved.
 */
export async function resolveRecentTurns(
  db: Kysely<Database>,
  limit: number,
): Promise<ResolvedTurn[]> {
  if (limit <= 0) {
    return [];
  }

  // Over-fetch originals so deletes / gaps still yield ~limit turns.
  const fetchLimit = Math.min(limit * 3, Math.max(limit, 600));

  const originals = await db
    .selectFrom("raw_log")
    .select("id")
    .where("edit_of", "is", null)
    .orderBy("id", "desc")
    .limit(fetchLimit)
    .execute();

  if (originals.length === 0) {
    return [];
  }

  const resolved = await resolveLatestContent(
    db,
    originals.map((r) => r.id),
  );

  const newestFirst: ResolvedTurn[] = [];
  for (const row of originals) {
    const turn = resolved.get(row.id);
    if (turn) {
      newestFirst.push(turn);
    }
    if (newestFirst.length >= limit) {
      break;
    }
  }

  return newestFirst.reverse();
}

function resolveOne(
  original: RawRow,
  edits: readonly RawRow[],
): ResolvedTurn | null {
  if (original.deleted_marker === 1) {
    return null;
  }

  const tip = edits.length > 0 ? edits[edits.length - 1]! : original;
  if (tip.deleted_marker === 1) {
    return null;
  }

  let wireContent = original.content;
  for (const row of edits) {
    if (row.deleted_marker === 1) {
      continue;
    }
    if (row.is_media_artifact !== 1) {
      wireContent = row.content;
    }
  }

  const media = mediaRefFromColumns(
    original.media_file_id,
    original.media_mime_type,
    original.media_kind,
  );

  return {
    id: original.id,
    timestamp: original.timestamp,
    role: original.role,
    content: tip.content,
    wireContent,
    chatId: original.chat_id,
    messageId: original.message_id,
    ...(media ? { media } : {}),
  };
}
