import type { Message } from "telegraf/types";

import type { InboundMessage, MediaRef } from "../messages.js";

/**
 * Extract a MediaRef from a Telegram message, if any.
 * Bytes are filled later by persistAndNormalize (file_id → base64) before
 * handleTurn; this step only captures file id + mime hint (§7.3).
 *
 * Uses Telegraf Message field presence checks — no JSON duck-typing.
 */
export function extractMediaRef(message: Message): MediaRef | undefined {
  if ("photo" in message && message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    return {
      fileId: largest.file_id,
      mimeType: "image/jpeg",
      kind: "image",
    };
  }

  if ("video" in message && message.video) {
    return {
      fileId: message.video.file_id,
      mimeType: message.video.mime_type ?? "video/mp4",
      kind: "video",
    };
  }

  if ("voice" in message && message.voice) {
    return {
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      kind: "audio",
    };
  }

  if ("audio" in message && message.audio) {
    return {
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type ?? "audio/mpeg",
      kind: "audio",
    };
  }

  if ("video_note" in message && message.video_note) {
    return {
      fileId: message.video_note.file_id,
      mimeType: "video/mp4",
      kind: "video",
    };
  }

  if ("document" in message && message.document) {
    return {
      fileId: message.document.file_id,
      mimeType: message.document.mime_type ?? "application/octet-stream",
      kind: "file",
    };
  }

  return undefined;
}

/** Text body for the raw log: message text, else caption, else empty. */
export function extractContent(message: Message): string {
  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }
  if ("caption" in message && typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

/**
 * True when the message carries user content worth logging
 * (text, caption, or media). Pure service messages are skipped.
 */
export function isContentMessage(message: Message): boolean {
  if ("text" in message && message.text) return true;
  if ("caption" in message && message.caption) return true;
  return extractMediaRef(message) !== undefined;
}

export function toInboundMessage(message: Message): InboundMessage {
  const media = extractMediaRef(message);
  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    role: "user",
    content: extractContent(message),
    timestamp: message.date,
    ...(media ? { media } : {}),
  };
}
