import type { ToolCall, ToolDefinition } from "../ai/types.js";

/** Turn-scoped inbound media handle for `fs_write` `source: "media:N"`. */
export interface TurnMediaRef {
  /** e.g. `media:0` */
  ref: string;
  kind: string;
  mimeType: string;
  fileName?: string;
  data: Buffer;
}

/** Per-turn context passed into tool executors. */
export interface ToolTurnContext {
  /** Current user burst text — used for per-turn FS path grants. */
  userMessage: string;
  mediaRefs: readonly TurnMediaRef[];
}

export interface ToolExecuteResult {
  /** String content returned to the model as the tool result. */
  content: string;
  isError?: boolean;
}

export type ToolExecutor = (args: unknown, ctx: ToolTurnContext) => Promise<ToolExecuteResult>;

export type { ToolCall, ToolDefinition };
