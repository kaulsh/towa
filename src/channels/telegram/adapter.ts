import { sql, type Kysely } from "kysely";
import { Telegraf } from "telegraf";
import type { Message } from "telegraf/types";
import pino from "pino";

import type { Database } from "../../db/types.js";
import {
  appendRawLogEdit,
  appendRawLogMessage,
} from "../../core/raw-log/index.js";
import {
  closeEpisode,
  deriveEpisodeBoundary,
} from "../../core/episodes/index.js";
import { enqueuePendingExtraction } from "../../core/write-path/queue.js";
import type {
  ChannelAdapter,
  DeleteEvent,
  EditEvent,
  InboundMessage,
  MediaRef,
  OutboundMessage,
  PresenceEvent,
} from "../adapter.js";
import {
  isContentMessage,
  toEditEvent,
  toInboundMessage,
} from "./normalize.js";
import type { TelegramAdapterConfig } from "./types.js";

const log = pino({ name: "telegram-adapter" });

/**
 * Look up the raw_log.id of the original message for a Telegram platform
 * message id. `source_meta` is the dumped Telegram Message (`raw`), which
 * always carries `message_id`. Prefers the first non-edit, non-delete row.
 */
async function findOriginalRawLogId(
  db: Kysely<Database>,
  platformMessageId: string,
): Promise<number | null> {
  const row = await db
    .selectFrom("raw_log")
    .select("id")
    .where(
      sql`CAST(json_extract(source_meta, '$.message_id') AS TEXT)`,
      "=",
      platformMessageId,
    )
    .where("edit_of", "is", null)
    .where("deleted_marker", "=", 0)
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();

  return row?.id ?? null;
}

function base64ToInputFile(data: string): { source: Buffer } {
  return { source: Buffer.from(data, "base64") };
}

/**
 * Create a `ChannelAdapter` backed by Telegraf (§7.2).
 *
 * Transport mode (long-polling by default, webhook when `config.webhook` is
 * set) is owned entirely inside this module — callers only see normalized
 * callbacks.
 *
 * Inbound events are appended via Phase 0 `appendRawLog*` helpers. An
 * assistant `send()` closes the current episode and enqueues extraction.
 *
 * Design flags (not improvised here):
 * - Telegram Bot API does not deliver user-delete or typing/presence updates
 *   to bots in a private chat, so `onDelete` / `onPresence` handlers are
 *   registered for the interface contract but never fired by platform events.
 *   When a delete signal exists, it must go through `appendRawLogDelete`
 *   (Phase 0) — never in-place mutation.
 * - Burst debounce (§6) is not implemented in this adapter; it belongs in the
 *   agent loop / harness, not the channel transport layer.
 */
export function createTelegramAdapter(
  db: Kysely<Database>,
  config: TelegramAdapterConfig,
): ChannelAdapter {
  const bot = new Telegraf(config.botToken);

  const messageHandlers: Array<(msg: InboundMessage) => void> = [];
  const editHandlers: Array<(edit: EditEvent) => void> = [];
  const deleteHandlers: Array<(del: DeleteEvent) => void> = [];
  const presenceHandlers: Array<(p: PresenceEvent) => void> = [];

  function isAllowedChat(chatId: number | string): boolean {
    return String(chatId) === config.chatId;
  }

  async function persistInbound(msg: InboundMessage): Promise<void> {
    await appendRawLogMessage(db, {
      timestamp: msg.timestamp,
      role: "user",
      content: msg.content,
      sourceMeta: msg.raw,
    });
  }

  async function persistEdit(edit: EditEvent): Promise<void> {
    const originalId = await findOriginalRawLogId(db, edit.platformMessageId);
    if (originalId === null) {
      log.warn(
        { platformMessageId: edit.platformMessageId },
        "edit for unknown platform message id — skipping raw-log append",
      );
      return;
    }
    await appendRawLogEdit(db, {
      originalId,
      timestamp: edit.timestamp,
      content: edit.content,
      sourceMeta: edit.raw,
    });
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

  bot.on("message", (ctx) => {
    void (async () => {
      const message = ctx.message;
      if (!isAllowedChat(message.chat.id)) {
        return;
      }
      if (!isContentMessage(message)) {
        return;
      }

      const inbound = toInboundMessage(message);
      try {
        await persistInbound(inbound);
      } catch (err) {
        log.error({ err }, "failed to append inbound message to raw log");
        return;
      }

      for (const handler of messageHandlers) {
        handler(inbound);
      }
    })();
  });

  bot.on("edited_message", (ctx) => {
    void (async () => {
      const message = ctx.editedMessage;
      if (!message || !("chat" in message)) {
        return;
      }
      if (!isAllowedChat(message.chat.id)) {
        return;
      }
      // edited_message can be a service-shaped Message; require content shape.
      if (!isContentMessage(message as Message)) {
        return;
      }

      const edit = toEditEvent(message as Message);
      try {
        await persistEdit(edit);
      } catch (err) {
        log.error({ err }, "failed to append edit to raw log");
        return;
      }

      for (const handler of editHandlers) {
        handler(edit);
      }
    })();
  });

  const adapter: ChannelAdapter = {
    start(): void {
      if (config.webhook) {
        const { domain, port, path, host, secretToken } = config.webhook;
        log.info(
          { mode: "webhook", domain, port, path },
          "starting Telegram bot",
        );
        void bot
          .launch({
            webhook: {
              domain,
              ...(port !== undefined ? { port } : {}),
              ...(path !== undefined ? { path } : {}),
              ...(host !== undefined ? { host } : {}),
              ...(secretToken !== undefined ? { secretToken } : {}),
            },
          })
          .catch((err) =>
            log.error({ err, mode: "webhook" }, "Telegram bot launch failed"),
          );
      } else {
        // Long-polling — zero infrastructure (§7.2).
        // `launch()`'s promise resolves when the bot stops, not when polling begins.
        log.info(
          { mode: "polling", chatId: config.chatId },
          "starting Telegram bot (long polling)",
        );
        void bot
          .launch()
          .catch((err) =>
            log.error({ err, mode: "polling" }, "Telegram bot launch failed"),
          );
      }
    },

    onMessage(handler: (msg: InboundMessage) => void): void {
      messageHandlers.push(handler);
    },

    onEdit(handler: (edit: EditEvent) => void): void {
      editHandlers.push(handler);
    },

    onDelete(handler: (del: DeleteEvent) => void): void {
      deleteHandlers.push(handler);
    },

    onPresence(handler: (p: PresenceEvent) => void): void {
      presenceHandlers.push(handler);
    },

    async send(chatId: string, message: OutboundMessage): Promise<string> {
      if (!isAllowedChat(chatId)) {
        throw new Error(
          `TelegramAdapter.send: chatId ${chatId} is not the allow-listed chat`,
        );
      }

      let sent: Message;
      switch (message.type) {
        case "text":
          sent = await bot.telegram.sendMessage(chatId, message.text);
          break;
        case "image":
          sent = await bot.telegram.sendPhoto(
            chatId,
            base64ToInputFile(message.data),
            message.caption !== undefined ? { caption: message.caption } : {},
          );
          break;
        case "video":
          sent = await bot.telegram.sendVideo(
            chatId,
            base64ToInputFile(message.data),
            message.caption !== undefined ? { caption: message.caption } : {},
          );
          break;
        case "audio":
          // §7.2 maps OutboundMessage audio → sendVoice.
          sent = await bot.telegram.sendVoice(
            chatId,
            base64ToInputFile(message.data),
            message.caption !== undefined ? { caption: message.caption } : {},
          );
          break;
        default: {
          const _exhaustive: never = message;
          throw new Error(
            `TelegramAdapter.send: unsupported OutboundMessage: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }

      const recordInRawLog =
        message.type !== "text" || message.recordInRawLog !== false;
      if (!recordInRawLog) {
        return String(sent.message_id);
      }

      const content =
        message.type === "text"
          ? message.text
          : (message.caption ?? "");

      const assistantRawLogId = await appendRawLogMessage(db, {
        timestamp: sent.date,
        role: "assistant",
        content,
        sourceMeta: sent,
      });

      await closeEpisodeAfterAssistant(assistantRawLogId, sent.date);

      return String(sent.message_id);
    },

    async fetchMedia(
      ref: MediaRef,
    ): Promise<{ data: Buffer; mimeType: string }> {
      // Best-effort: Telegram file refs expire (§7.3). Let failures propagate.
      const link = await bot.telegram.getFileLink(ref.platformFileId);
      const response = await fetch(link.href);
      if (!response.ok) {
        throw new Error(
          `TelegramAdapter.fetchMedia: HTTP ${response.status} fetching ${ref.platformFileId}`,
        );
      }
      const data = Buffer.from(await response.arrayBuffer());
      return { data, mimeType: ref.mimeType };
    },
  };

  return adapter;
}
