/**
 * Explicit Telegram Bot API surface used by the adapter.
 *
 * Wraps Telegraf's `Telegram` client for only the methods we call — each
 * method retries transient network / 429 / 5xx failures. No monkey-patching
 * of Telegraf internals; inbound transport (`launch` / polling) stays on
 * Telegraf, which already retries `getUpdates` blips itself.
 */

import type { Telegram } from "telegraf";
import type { Message } from "telegraf/types";

import { withTransientRetry, type TransientRetryOptions } from "./api-retry.js";
import { markdownToTelegramHtml } from "./markdown-to-telegram-html.js";

/** InputFile-shaped upload used for photo/video/voice buffers. */
export type TelegramUpload = { source: Buffer };

export type SendMessageParams = {
  chatId: string;
  text: string;
  replyToMessageId?: number;
};

export type SendMediaParams = {
  chatId: string;
  data: TelegramUpload;
  caption?: string;
};

export interface TelegramApi {
  getMe(): Promise<Awaited<ReturnType<Telegram["getMe"]>>>;
  deleteWebhook(extra?: Parameters<Telegram["deleteWebhook"]>[0]): Promise<true>;
  sendMessage(params: SendMessageParams): Promise<Message.TextMessage>;
  sendPhoto(params: SendMediaParams): Promise<Message.PhotoMessage>;
  sendVideo(params: SendMediaParams): Promise<Message.VideoMessage>;
  sendVoice(params: SendMediaParams): Promise<Message.VoiceMessage>;
  getFileLink(fileId: string): Promise<URL>;
}

export type CreateTelegramApiOptions = Omit<TransientRetryOptions, "label" | "shouldRetry">;

function retrying<T>(
  label: string,
  fn: () => Promise<T>,
  options: CreateTelegramApiOptions,
): Promise<T> {
  return withTransientRetry(fn, { ...options, label });
}

/**
 * Wrap a Telegraf `Telegram` instance with the narrow retrying API the
 * adapter needs.
 */
export function createTelegramApi(
  telegram: Telegram,
  options: CreateTelegramApiOptions = {},
): TelegramApi {
  return {
    getMe: () => retrying("getMe", () => telegram.getMe(), options),

    deleteWebhook: (extra) =>
      retrying("deleteWebhook", () => telegram.deleteWebhook(extra), options),

    sendMessage: ({ chatId, text, replyToMessageId }) =>
      retrying(
        "sendMessage",
        () =>
          telegram.sendMessage(chatId, markdownToTelegramHtml(text), {
            parse_mode: "HTML",
            reply_parameters:
              replyToMessageId !== undefined ? { message_id: replyToMessageId } : undefined,
          }),
        options,
      ),

    sendPhoto: ({ chatId, data, caption }) =>
      retrying(
        "sendPhoto",
        () => telegram.sendPhoto(chatId, data, caption !== undefined ? { caption } : undefined),
        options,
      ),

    sendVideo: ({ chatId, data, caption }) =>
      retrying(
        "sendVideo",
        () => telegram.sendVideo(chatId, data, caption !== undefined ? { caption } : undefined),
        options,
      ),

    sendVoice: ({ chatId, data, caption }) =>
      retrying(
        "sendVoice",
        () => telegram.sendVoice(chatId, data, caption !== undefined ? { caption } : undefined),
        options,
      ),

    getFileLink: (fileId) => retrying("getFileLink", () => telegram.getFileLink(fileId), options),
  };
}
