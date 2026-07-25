import type { Kysely } from "kysely";

import type { MediaRef } from "../messages.js";
import type { Database } from "../db/types.js";
import type {
  ChatMessage,
  LoadedChatModel,
  MessagePart,
} from "../ai/types.js";
import { getMediaBytes } from "../media-byte-cache.js";
import { appendRawLogEdit } from "../raw-log/index.js";
import type { ResolvedTurn } from "../raw-log/resolve-turns.js";

import type { EpisodeTurn } from "./types.js";

/**
 * Enrich episode turns with media transcripts/captions (§7.3).
 * Raw bytes are ephemeral; only the text artifact is durable.
 * Capability-gated; never fails the whole extraction on missing capability
 * or missing bytes — degrade to "media existed, no content."
 *
 * Prefer `MediaRef.data` (base64) when present; otherwise the process-local
 * media-byte cache filled on inbound download. Cache miss → no Telegram call.
 * Callers should pass wire/user caption content (not a prior media_artifact
 * tip) as `turn.content` so re-extract does not double-append artifacts.
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
      },
      isMediaArtifact: true,
    });
    appended += 1;
  }

  return appended;
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
  return `[${ref.kind} media present (${ref.mimeType}), no content extracted]`;
}

async function describeAudio(
  ref: MediaRef,
  chatModel: LoadedChatModel,
): Promise<string> {
  if (!chatModel.capabilities.audioInput) {
    return "[audio media present, no transcript — model lacks audioInput]";
  }
  const fetched = resolveMediaBytes(ref);
  if (!fetched) {
    return "[audio media present, no transcript — bytes unavailable]";
  }

  try {
    const parts: MessagePart[] = [
      {
        type: "text",
        text: "Transcribe this audio faithfully. Reply with only the transcript text.",
      },
      { type: "audio", data: fetched.data, mimeType: fetched.mimeType },
    ];
    const messages: ChatMessage[] = [{ role: "user", content: parts }];
    const out = await chatModel.generate({ messages });
    const transcript = out.text.trim();
    return transcript.length > 0
      ? `[audio transcript]: ${transcript}`
      : "[audio media present, no transcript — empty model output]";
  } catch {
    return "[audio media present, no transcript — generation failed]";
  }
}

async function describeImage(
  ref: MediaRef,
  chatModel: LoadedChatModel,
): Promise<string> {
  if (!chatModel.capabilities.vision) {
    return "[image media present, no caption — model lacks vision]";
  }
  const fetched = resolveMediaBytes(ref);
  if (!fetched) {
    return "[image media present, no caption — bytes unavailable]";
  }

  try {
    const parts: MessagePart[] = [
      {
        type: "text",
        text: "Describe this image concisely for durable memory. Reply with only the description.",
      },
      { type: "image", data: fetched.data, mimeType: fetched.mimeType },
    ];
    const messages: ChatMessage[] = [{ role: "user", content: parts }];
    const out = await chatModel.generate({ messages });
    const caption = out.text.trim();
    return caption.length > 0
      ? `[image description]: ${caption}`
      : "[image media present, no caption — empty model output]";
  } catch {
    return "[image media present, no caption — generation failed]";
  }
}
