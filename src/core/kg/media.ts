import type { ChannelAdapter, MediaRef } from "../../channels/adapter.js";
import type {
  ChatMessage,
  LoadedChatModel,
  MessagePart,
} from "../../models/types.js";

import type { EpisodeTurn } from "./types.js";

/**
 * Enrich episode turns with media transcripts/captions (§7.3).
 * Raw bytes are ephemeral; only the text artifact is durable.
 * Capability-gated; never fails the whole extraction on missing capability
 * or fetchMedia errors — degrade to "media existed, no content."
 */
export async function enrichTurnsWithMedia(
  turns: EpisodeTurn[],
  chatModel: LoadedChatModel,
  adapter: ChannelAdapter,
): Promise<EpisodeTurn[]> {
  const out: EpisodeTurn[] = [];
  for (const turn of turns) {
    const mediaRef = extractMediaRef(turn.sourceMeta);
    if (!mediaRef) {
      out.push(turn);
      continue;
    }

    const artifact = await describeMedia(mediaRef, chatModel, adapter);
    const content =
      turn.content.trim().length > 0
        ? `${turn.content}\n${artifact}`
        : artifact;
    out.push({ ...turn, content });
  }
  return out;
}

function extractMediaRef(sourceMeta: unknown): MediaRef | null {
  if (!sourceMeta || typeof sourceMeta !== "object") {
    return null;
  }
  const meta = sourceMeta as Record<string, unknown>;
  const candidate = meta.mediaRef ?? meta.media_ref;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const ref = candidate as Record<string, unknown>;
  const platformFileId = ref.platformFileId ?? ref.platform_file_id;
  const mimeType = ref.mimeType ?? ref.mime_type;
  const kind = ref.kind;
  if (
    typeof platformFileId !== "string" ||
    typeof mimeType !== "string" ||
    (kind !== "image" &&
      kind !== "video" &&
      kind !== "audio" &&
      kind !== "file")
  ) {
    return null;
  }
  return { platformFileId, mimeType, kind };
}

async function describeMedia(
  ref: MediaRef,
  chatModel: LoadedChatModel,
  adapter: ChannelAdapter,
): Promise<string> {
  if (ref.kind === "audio") {
    return describeAudio(ref, chatModel, adapter);
  }
  if (ref.kind === "image") {
    return describeImage(ref, chatModel, adapter);
  }
  // video / file: durable note only — no dedicated multimodal path in v1.
  return `[${ref.kind} media present (${ref.mimeType}), no content extracted]`;
}

async function describeAudio(
  ref: MediaRef,
  chatModel: LoadedChatModel,
  adapter: ChannelAdapter,
): Promise<string> {
  if (!chatModel.capabilities.audioInput) {
    return "[audio media present, no transcript — model lacks audioInput]";
  }
  let fetched: { data: Buffer; mimeType: string };
  try {
    fetched = await adapter.fetchMedia(ref);
  } catch {
    return "[audio media present, no transcript — fetch failed]";
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
  adapter: ChannelAdapter,
): Promise<string> {
  if (!chatModel.capabilities.vision) {
    return "[image media present, no caption — model lacks vision]";
  }
  let fetched: { data: Buffer; mimeType: string };
  try {
    fetched = await adapter.fetchMedia(ref);
  } catch {
    return "[image media present, no caption — fetch failed]";
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
