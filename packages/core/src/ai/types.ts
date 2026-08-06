import type { ZodType } from "zod";

/**
 * Segregated model interfaces — design doc §8.1.
 * Chat and embedding stay separate; do not merge into one optional-embed type.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

/** Multimodal image part (§7.3 vision path). */
export interface ImagePart {
  type: "image";
  data: Buffer;
  mimeType: string;
}

/** Multimodal audio part (§7.3 audioInput path). */
export interface AudioPart {
  type: "audio";
  data: Buffer;
  mimeType: string;
}

export type MessagePart = TextPart | ImagePart | AudioPart;

/** Native function-tool definition passed to `generate()` (§5.4 / §8.1). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod object schema for tool arguments (converted to JSON Schema by the loader). */
  parameters: ZodType;
}

/** One tool call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string from the provider. */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  /** Plain text, multimodal parts, or empty string when assistant only emits toolCalls. */
  content: string | MessagePart[];
  /** Present on assistant turns that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on `role: "tool"` turns — correlates with `ToolCall.id`. */
  toolCallId?: string;
}

/**
 * Minimal generate input: messages + optional structured-output schema
 * (Zod) and/or native tools. Do not pass `schema` and `tools` together.
 */
export interface GenerateInput {
  messages: ChatMessage[];
  /**
   * When set, the loader should return structured output matching this schema.
   * Callers must check `capabilities.structuredOutput` and fall back to
   * prompt-based JSON + parse + one retry when false (§8.1).
   * Incompatible with `tools` on the same call.
   */
  schema?: ZodType;
  /**
   * Native function tools (§5.4). Requires `capabilities.toolCalling`.
   * Incompatible with `schema` on the same call.
   */
  tools?: ToolDefinition[];
}

/** Post-response usage from the provider (§8.3) — feeds the headroom governor. */
export interface GenerateUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface GenerateOutput {
  /** Generated text (always present; may be empty when only toolCalls / structured). */
  text: string;
  /** Parsed structured payload when `schema` was provided; otherwise absent. */
  structured?: unknown;
  /** Tool calls when the model requested them (and `tools` was provided). */
  toolCalls?: ToolCall[];
  /** Present when the endpoint reports token usage. */
  usage?: GenerateUsage;
}

export interface ChatModelCapabilities {
  structuredOutput: boolean;
  toolCalling: boolean;
  vision: boolean;
  audioInput: boolean;
}

export interface LoadedChatModel {
  id: string;
  capabilities: ChatModelCapabilities;
  generate(input: GenerateInput): Promise<GenerateOutput>;
}

export interface LoadedEmbeddingModel {
  id: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
