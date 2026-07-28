import type { Message } from "telegraf/types";
import { Telegraf } from "telegraf";
import type { Kysely } from "kysely";
import pino from "pino";

import { appendRawLogMessage } from "../raw-log/index.js";
import { closeEpisode, deriveEpisodeBoundary } from "../episodes/index.js";
import { putMediaBytes } from "../media-byte-cache.js";
import { enqueuePendingExtraction } from "../extraction/queue.js";
import type { Database } from "../db/types.js";
import {
  durableMediaRef,
  type InboundMessage,
  type MediaRef,
  type SendOutbound,
} from "../messages.js";
import { createTelegramApi } from "./api.js";
import {
  extractMediaRef,
  isContentMessage,
  isUnsupportedMessage,
  toInboundMessage,
} from "./normalize.js";
import type { TelegramConfig } from "./types.js";

const log = pino({ name: "telegram" });

/** Static reply for inbound types we do not process (video, stickers, …). */
const UNSUPPORTED_REPLY = "I can't process this type of message. Sorry!";

function base64ToInputFile(data: string): { source: Buffer } {
  return { source: Buffer.from(data, "base64") };
}

/** Inbound callback the daemon wires after persistAndNormalize (§7). */
export type TelegramInboundHandler = (
  msg: InboundMessage,
) => void | Promise<void>;

export interface TelegramRuntime {
  /** Outbound send with raw_log + episode close when recording. */
  send: SendOutbound;
  /**
   * Wire Telegraf handlers, then launch transport (long-polling by default,
   * webhook when configured). Daemon passes the inbound harness callback.
   */
  start(inbound: TelegramInboundHandler): Promise<void>;
  /** Stop Telegraf (polling/webhook). */
  stop(): Promise<void>;
}

/**
 * Create a Telegram runtime backed by Telegraf (§7).
 *
 * Transport mode (long-polling by default, webhook when `config.webhook` is
 * set) is owned entirely inside this module. Inbound updates persist to
 * raw_log columns (`message_id`, media_*), download media to base64 for the
 * harness path + process-local byte cache for drain enrichment, then call
 * the daemon-supplied inbound handler — the harness does not register
 * callbacks or own Telegraf.
 *
 * Outbound Bot API calls go through `createTelegramApi` (narrow retrying
 * wrapper). Outbound durability (assistant raw_log + episode close) stays
 * inside `send` when the daemon calls it from `onTurnCompleted`.
 *
 * Design flags (not improvised here):
 * - Telegram Bot API does not deliver user-delete or typing/presence updates
 *   to bots in a private chat. When a delete signal exists, it must go
 *   through `appendRawLogDelete` — never in-place mutation.
 * - Platform message edits are not handled yet (no `edited_message` wiring).
 * - Burst debounce (§6) lives in the harness, not here.
 */
export function createTelegram(
  db: Kysely<Database>,
  config: TelegramConfig,
): TelegramRuntime {
  const bot = new Telegraf(config.botToken);

  const api = createTelegramApi(bot.telegram, {
    logger: log.child({ component: "telegram-api" }),
  });

  let inboundHandler: TelegramInboundHandler | null = null;
  let started = false;

  function isAllowedChat(chatId: number | string): boolean {
    return String(chatId) === config.chatId;
  }

  /** Private download — fills the process-local cache; not exposed on runtime. */
  async function downloadMedia(
    ref: MediaRef,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const link = await api.getFileLink(ref.fileId);
    const response = await fetch(link.href);
    if (!response.ok) {
      throw new Error(
        `Telegram.downloadMedia: HTTP ${response.status} fetching ${ref.fileId}`,
      );
    }
    const data = Buffer.from(await response.arrayBuffer());
    const mimeType = ref.mimeType;
    putMediaBytes(ref.fileId, data, mimeType);
    return { data, mimeType };
  }

  /**
   * Best-effort: attach base64 bytes onto `inbound.media.data` for the harness
   * path and seed the media-byte cache for drain. On failure, warn and return
   * the message unchanged (no bytes).
   */
  async function attachInboundMediaData(
    inbound: InboundMessage,
  ): Promise<InboundMessage> {
    const media = inbound.media;
    if (!media) {
      return inbound;
    }
    try {
      const fetched = await downloadMedia(media);
      return {
        ...inbound,
        media: {
          ...media,
          data: fetched.data.toString("base64"),
          mimeType: fetched.mimeType || media.mimeType,
        },
      };
    } catch (err) {
      log.warn(
        { err, fileId: media.fileId },
        "failed to download inbound media — continuing without bytes",
      );
      return inbound;
    }
  }

  /**
   * Normalize + download media bytes (base64 on media.data) so the harness
   * sees payloads before handleTurn. Failures leave media without data.
   */
  async function persistAndNormalize(
    message: Message,
  ): Promise<InboundMessage | null> {
    const inbound = await attachInboundMediaData(toInboundMessage(message));

    await appendRawLogMessage(db, {
      timestamp: inbound.timestamp,
      role: "user",
      content: inbound.content,
      chatId: inbound.chatId,
      messageId: inbound.messageId,
      media: inbound.media ? durableMediaRef(inbound.media) : null,
    });

    return inbound;
  }

  async function closeEpisodeAfterAssistant(
    assistantRawLogId: number,
    closedAt: number,
  ): Promise<void> {
    const boundary = await deriveEpisodeBoundary(db, assistantRawLogId);

    if (!boundary) {
      log.warn(
        { assistantRawLogId },
        "could not derive episode boundary after assistant send",
      );
      return;
    }

    const episodeId = await closeEpisode(db, {
      startMsgId: boundary.startMsgId,
      endMsgId: boundary.endMsgId,
      closedAt,
    });

    await enqueuePendingExtraction(db, episodeId);
  }

  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (!isAllowedChat(message.chat.id)) {
      return;
    }

    // Temporary diagnostic: full Telegraf message before normalize/download/harness.
    log.debug({ message }, "raw telegraf message");

    // Unsupported types: static reply-to only — no raw_log persist, no harness.
    if (isUnsupportedMessage(message)) {
      try {
        await api.sendMessage({
          chatId: String(message.chat.id),
          text: UNSUPPORTED_REPLY,
          replyToMessageId: message.message_id,
        });
      } catch (err) {
        log.warn(
          { err, messageId: message.message_id },
          "failed to send unsupported-message reply",
        );
      }
      return;
    }

    if (!isContentMessage(message)) {
      return;
    }

    const inbound = await persistAndNormalize(message);
    if (!inbound) {
      return;
    }

    if (!inboundHandler) {
      log.warn("inbound message before telegram.start() — dropping");
      return;
    }
    await inboundHandler(inbound);
  });

  return {
    async send(chatId, message) {
      if (!isAllowedChat(chatId)) {
        throw new Error(
          `Telegram.send: chatId ${chatId} is not the allow-listed chat`,
        );
      }

      let sent: Message;
      switch (message.type) {
        case "text":
          sent = await api.sendMessage({ chatId, text: message.text });
          break;
        case "image":
          sent = await api.sendPhoto({
            chatId,
            data: base64ToInputFile(message.data),
            ...(message.caption !== undefined
              ? { caption: message.caption }
              : {}),
          });
          break;
        case "video":
          sent = await api.sendVideo({
            chatId,
            data: base64ToInputFile(message.data),
            ...(message.caption !== undefined
              ? { caption: message.caption }
              : {}),
          });
          break;
        case "audio":
          // §7 maps OutboundMessage audio → sendVoice.
          sent = await api.sendVoice({
            chatId,
            data: base64ToInputFile(message.data),
            ...(message.caption !== undefined
              ? { caption: message.caption }
              : {}),
          });
          break;
        default: {
          const _exhaustive: never = message;
          throw new Error(
            `Telegram.send: unsupported OutboundMessage: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }

      const recordInRawLog =
        message.type !== "text" || message.recordInRawLog !== false;
      if (!recordInRawLog) {
        return String(sent.message_id);
      }

      const content =
        message.type === "text" ? message.text : (message.caption ?? "");

      // Video is omitted from extractMediaRef (unsupported inbound); build
      // the outbound ref from the Bot API reply after sendVideo.
      let outboundMedia = extractMediaRef(sent);
      if (
        !outboundMedia &&
        message.type === "video" &&
        "video" in sent &&
        sent.video
      ) {
        outboundMedia = {
          fileId: sent.video.file_id,
          mimeType: sent.video.mime_type ?? message.mimeType ?? "video/mp4",
          kind: "video",
          ...(sent.video.file_name !== undefined
            ? { fileName: sent.video.file_name }
            : {}),
        };
      }

      // Seed cache from bytes we already hold so drain can enrich assistant media.
      if (
        outboundMedia &&
        message.type !== "text" &&
        typeof message.data === "string"
      ) {
        putMediaBytes(
          outboundMedia.fileId,
          Buffer.from(message.data, "base64"),
          message.mimeType || outboundMedia.mimeType,
        );
      }

      const assistantRawLogId = await appendRawLogMessage(db, {
        timestamp: sent.date,
        role: "assistant",
        content,
        chatId: String(sent.chat.id),
        messageId: String(sent.message_id),
        media: outboundMedia ? durableMediaRef(outboundMedia) : null,
      });

      await closeEpisodeAfterAssistant(assistantRawLogId, sent.date);

      return String(sent.message_id);
    },

    async start(inbound: TelegramInboundHandler): Promise<void> {
      if (started) {
        throw new Error("createTelegram: start() called more than once");
      }
      started = true;
      inboundHandler = inbound;
      try {
        // Prefill botInfo via our retrying client so Telegraf's launch skips
        // its own unretried getMe. deleteWebhook is similarly pre-cleared
        // for polling; launch may call it again (idempotent).
        bot.botInfo = await api.getMe();

        if (config.webhook) {
          const { domain, port, path } = config.webhook;
          log.info(
            { mode: "webhook", domain, port, path },
            "starting Telegram bot",
          );
          await bot.launch({ webhook: config.webhook }, () =>
            log.info(
              { mode: "webhook" },
              "Telegram bot started — receiving updates",
            ),
          );
          return;
        }

        log.info(
          { mode: "polling", chatId: config.chatId },
          "starting Telegram bot (long polling)",
        );

        await api.deleteWebhook({});

        await bot.launch({}, () =>
          log.info(
            { mode: "polling" },
            "Telegram bot started — receiving updates",
          ),
        );
      } catch (err) {
        log.error({ err }, "Telegram bot stopped with error");
      }
    },

    async stop(): Promise<void> {
      bot.stop("stop");
      inboundHandler = null;
      log.info("Telegram bot stop requested");
    },
  };
}
