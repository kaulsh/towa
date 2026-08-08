import type { InboundMessage } from "../messages.js";
import type { LoadedChatModel, MessagePart } from "../ai/types.js";

/** Text for query-gen / logs, plus multimodal parts for reply-path generate. */
export interface UserTurnContent {
  text: string;
  mediaParts: MessagePart[];
}

function contentTextWithReply(msg: InboundMessage): string {
  let base = msg.content.trim();

  if (msg.replyTo) {
    // Rebuild reply prefix from typed field so generation does not depend on
    // parsing the durable content annotation.
    const withoutAnnotation = base.replace(
      /^\[reply to #\d+(?:: "[^"]*")?\]\s*/,
      "",
    );
    const replyPrefix =
      msg.replyTo.quote !== undefined
        ? `[reply to #${msg.replyTo.messageId}: "${msg.replyTo.quote}"]`
        : `[reply to #${msg.replyTo.messageId}]`;
    base = withoutAnnotation
      ? `${replyPrefix} ${withoutAnnotation}`
      : replyPrefix;
  }

  return base;
}

/**
 * Multimodal image parts for reply-path `generate()` when vision is enabled
 * and bytes are present (§7.3 / §8.1).
 *
 * Voice notes are **not** attached here — sync caption transcribes them to
 * text (`[audio transcript]: …`) and that text is what reaches the model.
 */
function mediaPartsForGeneration(
  msg: InboundMessage,
  chatModel: LoadedChatModel,
): MessagePart[] {
  const media = msg.media;
  if (!media?.data) return [];

  const data = Buffer.from(media.data, "base64");
  if (media.kind === "image" && chatModel.capabilities.vision) {
    return [{ type: "image", data, mimeType: media.mimeType }];
  }
  return [];
}

/**
 * Format a sync media artifact for reply-path generation.
 * Durable raw_log keeps `[audio transcript]:` / `[image description]:` markers;
 * the live prompt should read as user content, not a "please transcribe" job.
 */
function formatArtifactForGeneration(artifact: string): string {
  const audioPrefix = "[audio transcript]:";
  if (artifact.startsWith(audioPrefix)) {
    const spoken = artifact.slice(audioPrefix.length).trim();
    return spoken.length > 0
      ? `(voice note — already transcribed) ${spoken}`
      : "(voice note — empty transcript)";
  }
  const imagePrefix = "[image description]:";
  if (artifact.startsWith(imagePrefix)) {
    const desc = artifact.slice(imagePrefix.length).trim();
    return desc.length > 0
      ? `(image — description) ${desc}`
      : "(image — empty description)";
  }
  return artifact;
}

/**
 * Build user turn text (+ multimodal parts) for the reply path.
 * Query-gen / logging use `text`; answer generate uses `text` plus `mediaParts`.
 * When `mediaArtifacts` is set (sync caption), fold those into text.
 * Missing bytes or lacking capability → explicit text notes (no silent drop).
 */
export function buildUserTurnContent(
  messages: readonly InboundMessage[],
  chatModel: LoadedChatModel,
  mediaArtifacts?: ReadonlyMap<string, string>,
): UserTurnContent {
  const textChunks: string[] = [];
  const mediaParts: MessagePart[] = [];

  for (const msg of messages) {
    const base = contentTextWithReply(msg);
    const parts = mediaPartsForGeneration(msg, chatModel);
    mediaParts.push(...parts);
    const artifact = mediaArtifacts?.get(msg.messageId);

    if (!msg.media) {
      if (base) textChunks.push(base);
      else textChunks.push("(empty message)");
      continue;
    }

    const { kind, data, fileName } = msg.media;
    const nameNote = fileName ? ` "${fileName}"` : "";

    if (!data) {
      const note = `[user sent ${kind} media${nameNote}; content could not be loaded]`;
      textChunks.push(base ? `${base}\n${note}` : note);
      continue;
    }

    if (artifact) {
      const formatted = formatArtifactForGeneration(artifact);
      textChunks.push(base ? `${base}\n${formatted}` : formatted);
      continue;
    }

    if (parts.length > 0) {
      // Bytes go to generate(); keep a usable text stub for query-gen / FTS.
      textChunks.push(
        base ||
          (kind === "image"
            ? "(user sent an image)"
            : kind === "audio"
              ? "(user sent a voice note)"
              : `(user sent ${kind})`),
      );
      continue;
    }

    const note = `[user sent ${kind} media${nameNote}; content not available in this reply path]`;
    textChunks.push(base ? `${base}\n${note}` : note);
  }

  return {
    text: textChunks.filter((t) => t.length > 0).join("\n"),
    mediaParts,
  };
}
