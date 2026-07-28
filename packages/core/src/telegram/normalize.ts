import type {
  Chat,
  Message,
  MessageOriginChannel,
  MessageOriginChat,
  MessageOriginHiddenUser,
  MessageOriginUser,
  User,
} from "telegraf/types";

import type { InboundMessage, MediaRef, ReplyToRef } from "../messages.js";

/** Max characters kept for reply quote annotations / replyTo.quote. */
const REPLY_QUOTE_MAX = 120;

type MessageOrigin =
  | MessageOriginUser
  | MessageOriginHiddenUser
  | MessageOriginChat
  | MessageOriginChannel;

/**
 * Extract a MediaRef from a Telegram message, if any.
 * Bytes are filled later by persistAndNormalize (file_id → base64) before
 * handleTurn; this step only captures file id + mime hint (§7.3).
 *
 * Uses Telegraf Message field presence checks — no JSON duck-typing.
 * Image documents (`mime_type` starting with `image/`) map to kind `"image"`.
 * **Voice notes only** for audio (`message.voice`). Music/file audio uploads
 * are unsupported inbound (static reply) — see `isUnsupportedMessage`.
 * Video / video_note are unsupported inbound and are never returned here;
 * outbound video refs are built in `createTelegram.send` after `sendVideo`.
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

  if ("voice" in message && message.voice) {
    return {
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type ?? "audio/ogg",
      kind: "audio",
    };
  }

  if ("document" in message && message.document) {
    const mimeType = message.document.mime_type ?? "application/octet-stream";
    // Audio documents are unsupported (see isUnsupportedMessage); images promote.
    if (mimeType.startsWith("audio/")) {
      return undefined;
    }
    const kind = mimeType.startsWith("image/") ? "image" : "file";
    return {
      fileId: message.document.file_id,
      mimeType,
      kind,
      ...(message.document.file_name !== undefined
        ? { fileName: message.document.file_name }
        : {}),
    };
  }

  return undefined;
}

function truncateQuote(text: string): string {
  if (text.length <= REPLY_QUOTE_MAX) {
    return text;
  }
  return `${text.slice(0, REPLY_QUOTE_MAX - 1)}...`;
}

function formatPersonName(user: User): string {
  if (user.username) {
    return `@${user.username}`;
  }
  const parts = [user.first_name, user.last_name].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.join(" ") || "unknown";
}

function formatChatName(chat: Chat): string {
  if ("title" in chat && typeof chat.title === "string" && chat.title) {
    return chat.title;
  }
  if (
    "username" in chat &&
    typeof chat.username === "string" &&
    chat.username
  ) {
    return `@${chat.username}`;
  }
  if (
    "first_name" in chat &&
    typeof chat.first_name === "string" &&
    chat.first_name
  ) {
    const last =
      "last_name" in chat && typeof chat.last_name === "string"
        ? chat.last_name
        : undefined;
    return [chat.first_name, last].filter(Boolean).join(" ");
  }
  return "unknown";
}

function formatForwardOrigin(origin: MessageOrigin): string {
  switch (origin.type) {
    case "user":
      return formatPersonName(origin.sender_user);
    case "hidden_user":
      return origin.sender_user_name;
    case "chat":
      return formatChatName(origin.sender_chat);
    case "channel":
      return formatChatName(origin.chat);
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

/**
 * Legacy forward_* fields still appear on some updates alongside forward_origin.
 * Typed locally — not part of the current Telegraf Message surface.
 */
interface LegacyForwardFields {
  forward_from?: User;
  forward_sender_name?: string;
  forward_from_chat?: Chat;
}

function extractForwardFrom(message: Message): string | undefined {
  if ("forward_origin" in message && message.forward_origin) {
    return formatForwardOrigin(message.forward_origin);
  }

  const legacy = message as Message & LegacyForwardFields;
  if (legacy.forward_from) {
    return formatPersonName(legacy.forward_from);
  }
  if (
    typeof legacy.forward_sender_name === "string" &&
    legacy.forward_sender_name.length > 0
  ) {
    return legacy.forward_sender_name;
  }
  if (legacy.forward_from_chat) {
    return formatChatName(legacy.forward_from_chat);
  }
  return undefined;
}

function extractLocationContent(message: Message): string | undefined {
  if ("venue" in message && message.venue) {
    const { latitude, longitude } = message.venue.location;
    return `[location: ${latitude}, ${longitude}]`;
  }
  if ("location" in message && message.location) {
    const { latitude, longitude } = message.location;
    return `[location: ${latitude}, ${longitude}]`;
  }
  return undefined;
}

function parentQuoteText(parent: Message): string | undefined {
  if ("text" in parent && typeof parent.text === "string" && parent.text) {
    return parent.text;
  }
  if (
    "caption" in parent &&
    typeof parent.caption === "string" &&
    parent.caption
  ) {
    return parent.caption;
  }
  return undefined;
}

function extractReplyTo(message: Message): ReplyToRef | undefined {
  if (!("reply_to_message" in message) || !message.reply_to_message) {
    return undefined;
  }
  const parent = message.reply_to_message;
  const messageId = String(parent.message_id);

  let quote: string | undefined;
  if ("quote" in message && message.quote?.text) {
    quote = truncateQuote(message.quote.text);
  } else {
    const fromParent = parentQuoteText(parent as Message);
    if (fromParent) {
      quote = truncateQuote(fromParent);
    }
  }

  return quote !== undefined ? { messageId, quote } : { messageId };
}

function annotateReply(body: string, replyTo: ReplyToRef): string {
  const prefix =
    replyTo.quote !== undefined
      ? `[reply to #${replyTo.messageId}: "${replyTo.quote}"]`
      : `[reply to #${replyTo.messageId}]`;
  return body.length > 0 ? `${prefix} ${body}` : prefix;
}

function annotateForward(body: string, from: string): string {
  const prefix = `[forwarded from ${from}]:`;
  return body.length > 0 ? `${prefix} ${body}` : prefix;
}

/** Text body for the raw log: message text, else caption, else location, else empty. */
export function extractContent(message: Message): string {
  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }
  if ("caption" in message && typeof message.caption === "string") {
    return message.caption;
  }
  return extractLocationContent(message) ?? "";
}

/**
 * True when the message carries user content worth logging
 * (text, caption, location/venue, or media). Pure service messages are skipped
 * by the unsupported path instead.
 */
export function isContentMessage(message: Message): boolean {
  if ("text" in message && message.text) return true;
  if ("caption" in message && message.caption) return true;
  if ("location" in message && message.location) return true;
  if ("venue" in message && message.venue) return true;
  return extractMediaRef(message) !== undefined;
}

/**
 * Messages we acknowledge with a static reply and never send to the harness:
 * video / video_note, music/file audio (non-voice), stickers, animations,
 * and anything that is not a supported content turn (polls, dice, …).
 * Telegram voice notes (`message.voice`) remain supported.
 */
export function isUnsupportedMessage(message: Message): boolean {
  if ("video" in message && message.video) return true;
  if ("video_note" in message && message.video_note) return true;
  if ("audio" in message && message.audio) return true;
  if (
    "document" in message &&
    message.document?.mime_type?.startsWith("audio/")
  ) {
    return true;
  }
  if ("sticker" in message && message.sticker) return true;
  if ("animation" in message && message.animation) return true;
  return !isContentMessage(message);
}

export function toInboundMessage(message: Message): InboundMessage {
  const media = extractMediaRef(message);

  let content = extractContent(message);
  const forwardFrom = extractForwardFrom(message);
  if (forwardFrom) {
    content = annotateForward(content, forwardFrom);
  }

  const replyTo = extractReplyTo(message);
  if (replyTo) {
    content = annotateReply(content, replyTo);
  }

  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    role: "user",
    content,
    timestamp: message.date,
    ...(media ? { media } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}
