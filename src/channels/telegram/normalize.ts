import type { Message } from "telegraf/types";

import type {
  EditEvent,
  InboundMessage,
  MediaRef,
} from "../adapter.js";

/**
 * Extract a MediaRef from a Telegram message, if any.
 * Bytes are never captured here — only a platform file id + mime hint (§7.3).
 */
export function extractMediaRef(message: Message): MediaRef | undefined {
  if ("photo" in message && message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      platformFileId: largest.file_id,
      mimeType: "image/jpeg",
      kind: "image",
    };
  }

  if ("video" in message && message.video) {
    return {
      platformFileId: message.video.file_id,
      mimeType: message.video.mime_type ?? "video/mp4",
      kind: "video",
    };
  }

  if ("voice" in message && message.voice) {
    return {
      platformFileId: message.voice.file_id,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      kind: "audio",
    };
  }

  if ("audio" in message && message.audio) {
    return {
      platformFileId: message.audio.file_id,
      mimeType: message.audio.mime_type ?? "audio/mpeg",
      kind: "audio",
    };
  }

  if ("video_note" in message && message.video_note) {
    return {
      platformFileId: message.video_note.file_id,
      mimeType: "video/mp4",
      kind: "video",
    };
  }

  if ("document" in message && message.document) {
    return {
      platformFileId: message.document.file_id,
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
  const mediaRef = extractMediaRef(message);
  return {
    chatId: String(message.chat.id),
    role: "user",
    content: extractContent(message),
    timestamp: message.date,
    ...(mediaRef ? { mediaRef } : {}),
    raw: message,
  };
}

export function toEditEvent(message: Message): EditEvent {
  const mediaRef = extractMediaRef(message);
  const editDate =
    "edit_date" in message && typeof message.edit_date === "number"
      ? message.edit_date
      : message.date;
  return {
    chatId: String(message.chat.id),
    platformMessageId: String(message.message_id),
    content: extractContent(message),
    timestamp: editDate,
    ...(mediaRef ? { mediaRef } : {}),
    raw: message,
  };
}
