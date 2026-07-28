import type { Kysely } from "kysely";

import type { InboundMessage, MediaRef } from "../messages.js";
import type { Database } from "../db/types.js";
import type { ChatMessage, LoadedChatModel, MessagePart } from "../ai/types.js";
import { getMediaBytes } from "../media-byte-cache.js";
import { appendRawLogEdit } from "../raw-log/index.js";
import type { ResolvedTurn } from "../raw-log/resolve-turns.js";

import type { EpisodeTurn } from "./types.js";

/** True when content already has a successful durable media text artifact (§7.3). */
export function contentHasMediaArtifact(content: string): boolean {
  // Only successful captions/transcripts — presence/failure notes must not
  // block a later retry (sync regenerate or drain).
  return (
    content.includes("[image description]:") ||
    content.includes("[audio transcript]:")
  );
}

/**
 * Enrich episode turns with media transcripts/captions (§7.3).
 * Raw bytes are ephemeral; only the text artifact is durable.
 * Capability-gated; never fails the whole extraction on missing capability
 * or missing bytes — degrade to "media existed, no content."
 *
 * Prefer `MediaRef.data` (base64) when present; otherwise the process-local
 * media-byte cache filled on inbound download. Cache miss → no Telegram call.
 * Callers should pass wire/user caption content (not a prior media_artifact
 * tip) as `turn.content` so re-extract does not double-append artifacts —
 * unless the tip was already captioned on the reply path, in which case pass
 * tip content and this skips the LLM (`contentHasMediaArtifact`).
 * Reads `turn.media` — never scrapes opaque JSON.
 */
export async function enrichTurnsWithMedia(
  turns: EpisodeTurn[],
  chatModel: LoadedChatModel,
): Promise<EpisodeTurn[]> {
  const out: EpisodeTurn[] = [];
  for (const turn of turns) {
    const media = turn.media;
    if (!media) {
      out.push(turn);
      continue;
    }

    // Reply-path sync caption already persisted — do not re-run vision/audio.
    if (contentHasMediaArtifact(turn.content)) {
      out.push(turn);
      continue;
    }

    const artifact = await describeMedia(media, chatModel);
    const content =
      turn.content.trim().length > 0
        ? `${turn.content}\n${artifact}`
        : artifact;
    out.push({ ...turn, content });
  }
  return out;
}

/**
 * Persist enriched media text via append-only edits (§2.1 / §7.3).
 *
 * Idempotency: skip when the latest resolved tip already equals the enriched
 * content — re-runs do not spam duplicate identical edits. When enrichment
 * improves the transcript, a new edit is appended (never UPDATE/DELETE the
 * original). All writes are short and separate from any LLM call (§4.2).
 */
export async function persistMediaTextArtifacts(
  db: Kysely<Database>,
  before: readonly ResolvedTurn[],
  enriched: readonly EpisodeTurn[],
): Promise<number> {
  const beforeById = new Map(before.map((t) => [t.id, t]));
  let appended = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const turn of enriched) {
    const prior = beforeById.get(turn.rawLogId);
    if (!prior) {
      continue;
    }
    const media = turn.media;
    if (!media) {
      continue;
    }
    if (turn.content === prior.content) {
      // Latest tip already matches — nothing to write.
      continue;
    }

    await appendRawLogEdit(db, {
      originalId: turn.rawLogId,
      timestamp: nowSec,
      content: turn.content,
      chatId: prior.chatId,
      messageId: prior.messageId,
      media: {
        fileId: media.fileId,
        mimeType: media.mimeType,
        kind: media.kind,
        ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
      },
      isMediaArtifact: true,
    });
    appended += 1;
  }

  return appended;
}

export interface CaptionInboundMediaResult {
  /**
   * Artifact line(s) per platform `messageId` (e.g. `[image description]: …`).
   * Fold into reply-path generation text; empty map when nothing to caption.
   */
  artifactsByMessageId: Map<string, string>;
  /** How many media_artifact edits were appended. */
  appended: number;
}

/**
 * Sync media caption/transcript before the reply (§7.3).
 *
 * Runs describe LLM(s) for inbound media, appends durable media_artifact edits,
 * and returns artifact text for the generation prompt. KG extraction stays
 * async on the drain path; drain skips re-describe when the tip already has
 * an artifact (`contentHasMediaArtifact`).
 *
 * LLM work happens before the short append writes (§4.2).
 */
export async function captionAndPersistInboundMedia(
  db: Kysely<Database>,
  messages: readonly InboundMessage[],
  chatModel: LoadedChatModel,
): Promise<CaptionInboundMediaResult> {
  const artifactsByMessageId = new Map<string, string>();
  let appended = 0;

  for (const msg of messages) {
    const media = msg.media;
    if (!media) {
      continue;
    }

    const original = await db
      .selectFrom("raw_log")
      .select(["id", "content", "chat_id", "message_id"])
      .where("chat_id", "=", msg.chatId)
      .where("message_id", "=", msg.messageId)
      .where("edit_of", "is", null)
      .where("deleted_marker", "=", 0)
      .executeTakeFirst();

    if (!original) {
      continue;
    }

    // Tip may already include a prior sync caption (late-arrival regenerate).
    const tip = await db
      .selectFrom("raw_log")
      .select(["content", "is_media_artifact"])
      .where((eb) =>
        eb.or([eb("id", "=", original.id), eb("edit_of", "=", original.id)]),
      )
      .where("deleted_marker", "=", 0)
      .orderBy("id", "asc")
      .execute();
    const latest = tip[tip.length - 1]!;
    if (contentHasMediaArtifact(latest.content)) {
      const artifact = extractTrailingArtifact(latest.content);
      if (artifact) {
        artifactsByMessageId.set(msg.messageId, artifact);
      }
      continue;
    }

    const artifact = await describeMedia(media, chatModel);
    artifactsByMessageId.set(msg.messageId, artifact);

    const wireBase = original.content.trim();
    const enrichedContent =
      wireBase.length > 0 ? `${wireBase}\n${artifact}` : artifact;

    if (enrichedContent === latest.content) {
      continue;
    }

    await appendRawLogEdit(db, {
      originalId: original.id,
      timestamp: Math.floor(Date.now() / 1000),
      content: enrichedContent,
      chatId: original.chat_id,
      messageId: original.message_id,
      media: {
        fileId: media.fileId,
        mimeType: media.mimeType,
        kind: media.kind,
        ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
      },
      isMediaArtifact: true,
    });
    appended += 1;
  }

  return { artifactsByMessageId, appended };
}

/** Pull the media artifact line(s) from an already-enriched tip. */
function extractTrailingArtifact(content: string): string | null {
  const markers = [
    "[image description]:",
    "[audio transcript]:",
    "[image media present",
    "[audio media present",
    "[video media present",
    "[file media present",
  ];
  let idx = -1;
  for (const m of markers) {
    const at = content.indexOf(m);
    if (at >= 0 && (idx < 0 || at < idx)) {
      idx = at;
    }
  }
  if (idx < 0) return null;
  return content.slice(idx).trim();
}

function resolveMediaBytes(
  ref: MediaRef,
): { data: Buffer; mimeType: string } | null {
  if (ref.data) {
    return {
      data: Buffer.from(ref.data, "base64"),
      mimeType: ref.mimeType,
    };
  }
  return getMediaBytes(ref.fileId);
}

async function describeMedia(
  ref: MediaRef,
  chatModel: LoadedChatModel,
): Promise<string> {
  if (ref.kind === "audio") {
    return describeAudio(ref, chatModel);
  }
  if (ref.kind === "image") {
    return describeImage(ref, chatModel);
  }
  // video / file: durable note only — no dedicated multimodal path in v1.
  const name = ref.fileName ? `, ${ref.fileName}` : "";
  return `[${ref.kind} media present (${ref.mimeType}${name}), no content extracted]`;
}

async function describeAudio(
  ref: MediaRef,
  chatModel: LoadedChatModel,
): Promise<string> {
  const name = ref.fileName ? ` (${ref.fileName})` : "";
  if (!chatModel.capabilities.audioInput) {
    return `[audio media present${name}, no transcript — model lacks audioInput]`;
  }
  const fetched = resolveMediaBytes(ref);
  if (!fetched) {
    return `[audio media present${name}, no transcript — bytes unavailable]`;
  }

  try {
    // Media before text — Gemma multimodal guidance.
    const parts: MessagePart[] = [
      { type: "audio", data: fetched.data, mimeType: fetched.mimeType },
      {
        type: "text",
        text: "Transcribe this audio faithfully. Reply with only the transcript text.",
      },
    ];
    const messages: ChatMessage[] = [{ role: "user", content: parts }];
    const out = await chatModel.generate({ messages });
    const transcript = out.text.trim();
    return transcript.length > 0
      ? `[audio transcript]: ${transcript}`
      : `[audio media present${name}, no transcript — empty model output]`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `[audio media present${name}, no transcript — generation failed: ${detail.slice(0, 240)}]`;
  }
}

async function describeImage(
  ref: MediaRef,
  chatModel: LoadedChatModel,
): Promise<string> {
  const name = ref.fileName ? ` (${ref.fileName})` : "";
  if (!chatModel.capabilities.vision) {
    return `[image media present${name}, no caption — model lacks vision]`;
  }
  const fetched = resolveMediaBytes(ref);
  if (!fetched) {
    return `[image media present${name}, no caption — bytes unavailable]`;
  }

  try {
    // Media before text — Gemma multimodal guidance.
    const parts: MessagePart[] = [
      { type: "image", data: fetched.data, mimeType: fetched.mimeType },
      {
        type: "text",
        text: "Describe this image concisely for durable memory. Mention all objects, people, and the scene. Reply with only this description.",
      },
    ];
    const messages: ChatMessage[] = [{ role: "user", content: parts }];
    const out = await chatModel.generate({ messages });
    const caption = out.text.trim();
    return caption.length > 0
      ? `[image description]: ${caption}`
      : `[image media present${name}, no caption — empty model output]`;
  } catch {
    return `[image media present${name}, no caption — generation failed]`;
  }
}
