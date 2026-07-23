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

import {
  withTransientRetry,
  type TransientRetryOptions,
} from "./api-retry.js";

/** InputFile-shaped upload used for photo/video/voice buffers. */
export type TelegramUpload = { source: Buffer };

export interface TelegramApi {
  getMe(): Promise<Awaited<ReturnType<Telegram["getMe"]>>>;
  deleteWebhook(
    extra?: Parameters<Telegram["deleteWebhook"]>[0],
  ): Promise<true>;
  sendMessage(chatId: string, text: string): Promise<Message.TextMessage>;
  sendPhoto(
    chatId: string,
    photo: TelegramUpload,
    extra?: { caption?: string },
  ): Promise<Message.PhotoMessage>;
  sendVideo(
    chatId: string,
    video: TelegramUpload,
    extra?: { caption?: string },
  ): Promise<Message.VideoMessage>;
  sendVoice(
    chatId: string,
    voice: TelegramUpload,
    extra?: { caption?: string },
  ): Promise<Message.VoiceMessage>;
  getFileLink(fileId: string): Promise<URL>;
}

export type CreateTelegramApiOptions = Omit<
  TransientRetryOptions,
  "label" | "shouldRetry"
>;

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
      retrying(
        "deleteWebhook",
        () => telegram.deleteWebhook(extra),
        options,
      ),

    sendMessage: (chatId, text) =>
      retrying(
        "sendMessage",
        () => telegram.sendMessage(chatId, text),
        options,
      ),

    sendPhoto: (chatId, photo, extra) =>
      retrying(
        "sendPhoto",
        () => telegram.sendPhoto(chatId, photo, extra),
        options,
      ),

    sendVideo: (chatId, video, extra) =>
      retrying(
        "sendVideo",
        () => telegram.sendVideo(chatId, video, extra),
        options,
      ),

    sendVoice: (chatId, voice, extra) =>
      retrying(
        "sendVoice",
        () => telegram.sendVoice(chatId, voice, extra),
        options,
      ),

    getFileLink: (fileId) =>
      retrying("getFileLink", () => telegram.getFileLink(fileId), options),
  };
}
