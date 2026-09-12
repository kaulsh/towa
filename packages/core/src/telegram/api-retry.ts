/**
 * Transient-retry helper for Telegram Bot API calls.
 *
 * Used by `createTelegramApi` — not applied by monkey-patching Telegraf.
 */

import { getLogger } from "../logging.js";

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface TransientRetryOptions {
  /** Label included in warn logs (e.g. API method name). */
  label?: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Return false to stop retrying even if the error looks transient
   * (e.g. AbortSignal fired while stopping the bot).
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  err: unknown,
): number {
  const retryAfter = telegramRetryAfterSeconds(err);
  if (retryAfter !== undefined) {
    return Math.max(retryAfter * 1000, baseDelayMs);
  }
  const exp = Math.min(attempt - 1, 5);
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exp);
}

function telegramRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const params = (err as { parameters?: { retry_after?: unknown } }).parameters;
  return typeof params?.retry_after === "number" ? params.retry_after : undefined;
}

/**
 * Network blips + Telegram 429 / 5xx. Auth (401) and conflict (409) are not
 * transient — retrying those loops forever on a bad token / competing poller.
 */
export function isTransientTelegramApiError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    name?: string;
    code?: string | number;
    message?: string;
  };

  if (e.name === "AbortError") return false;

  if (e.name === "FetchError") return true;
  if (
    e.code === "ECONNRESET" ||
    e.code === "ECONNREFUSED" ||
    e.code === "ETIMEDOUT" ||
    e.code === "ENOTFOUND" ||
    e.code === "EAI_AGAIN" ||
    e.code === "EPIPE" ||
    e.code === "UND_ERR_CONNECT_TIMEOUT" ||
    e.code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  if (typeof e.code === "number" && (e.code === 429 || e.code >= 500)) {
    return true;
  }
  const msg = e.message ?? "";
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
}

const log = getLogger("telegram-api");

/**
 * Retry `fn` on transient Telegram/network errors with exponential backoff
 * (honors `retry_after` when present).
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const label = options.label ?? "operation";
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const allow =
        isTransientTelegramApiError(err) && (options.shouldRetry?.(err, attempt) ?? true);
      if (!allow) throw err;

      const retryInMs = retryDelayMs(attempt, baseDelayMs, maxDelayMs, err);
      log.warn({ err, label, attempt, retryInMs }, "transient failure; retrying");
      await sleep(retryInMs);
    }
  }
}
