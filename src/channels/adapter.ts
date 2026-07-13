/**
 * Channel adapter interface — design doc §7.1.
 * Core harness only ever sees these normalized shapes; transport mode
 * (polling / webhook / websocket) is owned entirely by the adapter.
 */

export interface MediaRef {
  platformFileId: string;
  mimeType: string;
  kind: "image" | "video" | "audio" | "file";
}

export interface InboundMessage {
  chatId: string;
  role: "user";
  content: string;
  timestamp: number;
  mediaRef?: MediaRef;
  /** Dumped straight into raw_log.source_meta. */
  raw: unknown;
}

export type OutboundMessage =
  | { type: "text"; text: string }
  | { type: "image"; caption?: string; data: string; mimeType: string }
  | { type: "video"; caption?: string; data: string; mimeType: string }
  | { type: "audio"; caption?: string; data: string; mimeType: string };

/**
 * Platform edit event. Mapped to `appendRawLogEdit` via the original
 * platform message id carried in source_meta / looked up by the harness.
 */
export interface EditEvent {
  chatId: string;
  /** Platform-native message id of the message being edited. */
  platformMessageId: string;
  content: string;
  timestamp: number;
  mediaRef?: MediaRef;
  raw: unknown;
}

/**
 * Platform delete event. Mapped to `appendRawLogDelete` — append-only;
 * never an in-place DELETE on raw_log.
 */
export interface DeleteEvent {
  chatId: string;
  platformMessageId: string;
  timestamp: number;
  raw: unknown;
}

/** Presence/typing signal — optional; widens burst debounce (§6). */
export interface PresenceEvent {
  chatId: string;
  kind: "typing" | "recording" | "other";
  timestamp: number;
}

export interface ChannelAdapter {
  start(): void;
  onMessage(handler: (msg: InboundMessage) => void): void;
  onEdit(handler: (edit: EditEvent) => void): void;
  onDelete(handler: (del: DeleteEvent) => void): void;
  onPresence?(handler: (p: PresenceEvent) => void): void;

  /** Returns the platform message id of the sent message. */
  send(chatId: string, message: OutboundMessage): Promise<string>;
  fetchMedia(ref: MediaRef): Promise<{ data: Buffer; mimeType: string }>;
}
