import type { ZodType } from "zod";

/**
 * Segregated model interfaces — design doc §8.1.
 * Chat and embedding stay separate; do not merge into one optional-embed type.
 */

export type ChatRole = "system" | "user" | "assistant";

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

export interface ChatMessage {
  role: ChatRole;
  /** Plain text, or multimodal parts when vision/audio capabilities are used. */
  content: string | MessagePart[];
}

/**
 * Minimal generate input: messages + optional structured-output schema
 * (Zod) + optional multimodal content via MessagePart[].
 */
export interface GenerateInput {
  messages: ChatMessage[];
  /**
   * When set, the loader should return structured output matching this schema.
   * Callers must check `capabilities.structuredOutput` and fall back to
   * prompt-based JSON + parse + one retry when false (§8.1).
   */
  schema?: ZodType;
}

/** Post-response usage from the provider (§8.3) — feeds the headroom governor. */
export interface GenerateUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface GenerateOutput {
  /** Generated text (always present; may be empty when only structured is used). */
  text: string;
  /** Parsed structured payload when `schema` was provided; otherwise absent. */
  structured?: unknown;
  /** Present when the endpoint reports token usage. */
  usage?: GenerateUsage;
}

export interface ChatModelCapabilities {
  structuredOutput: boolean;
  vision: boolean;
  audioInput: boolean;
  contextWindow: number;
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
