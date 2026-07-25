/**
 * Shared inbound/outbound message shapes used by the harness and Telegram
 * runtime (§7). Generic names — no ChannelAdapter dual-DTO layer.
 */

export type MediaKind = "image" | "audio" | "video" | "file";

export interface MediaRef {
  fileId: string;
  mimeType: string;
  kind: MediaKind;
  /**
   * Ephemeral base64 bytes for the in-memory inbound / harness path.
   * Never written to `raw_log` — durable memory stores only the ref + text
   * artifact (§7.3). Strip before persisting media columns.
   */
  data?: string;
}

/** Durable MediaRef fields only (no ephemeral base64). */
export function durableMediaRef(ref: MediaRef): Omit<MediaRef, "data"> {
  return {
    fileId: ref.fileId,
    mimeType: ref.mimeType,
    kind: ref.kind,
  };
}

export function isMediaKind(value: string): value is MediaKind {
  return (
    value === "image" ||
    value === "audio" ||
    value === "video" ||
    value === "file"
  );
}

export interface InboundMessage {
  chatId: string;
  /** Platform-native message id (e.g. Telegram message_id). */
  messageId: string;
  role: "user";
  content: string;
  timestamp: number;
  /** May include ephemeral `data` (base64) for the harness; strip for raw_log. */
  media?: MediaRef;
}

export type OutboundMessage =
  | {
      type: "text";
      text: string;
      /**
       * When false, send on the wire only — do not append `raw_log` or close
       * an episode. For transport-only notices (e.g. harness error apologies)
       * that must not enter durable memory / working context. Default true.
       */
      recordInRawLog?: boolean;
    }
  | { type: "image"; caption?: string; data: string; mimeType: string }
  | { type: "video"; caption?: string; data: string; mimeType: string }
  | { type: "audio"; caption?: string; data: string; mimeType: string };

/**
 * One logical turn's delivery payload. Harness builds this; the daemon sends
 * via `telegram.send` in an `onTurnCompleted` handler (§6, §7).
 */
export interface TurnResult {
  chatId: string;
  outbound: OutboundMessage[];
}

/**
 * Platform delete event. Mapped to `appendRawLogDelete` — append-only;
 * never an in-place DELETE on raw_log.
 */
export interface DeleteEvent {
  chatId: string;
  messageId: string;
  timestamp: number;
}

/** Outbound send port (Telegram `send`; not injected into the harness). */
export type SendOutbound = (
  chatId: string,
  message: OutboundMessage,
) => Promise<string>;
