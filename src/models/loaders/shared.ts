import type { ZodType } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  ChatMessage,
  ChatModelCapabilities,
  GenerateInput,
  MessagePart,
} from "../types.js";

/** Extract a JSON Schema object from a Zod schema via the OpenAI helper. */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const format = zodResponseFormat(schema, "output");
  const jsonSchema = format.json_schema.schema;
  if (jsonSchema === undefined || jsonSchema === null) {
    throw new Error("Failed to convert Zod schema to JSON Schema");
  }
  return jsonSchema as Record<string, unknown>;
}

export function flattenMessageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function messageHasImage(content: ChatMessage["content"]): boolean {
  return typeof content !== "string" && content.some((p) => p.type === "image");
}

export function messageHasAudio(content: ChatMessage["content"]): boolean {
  return typeof content !== "string" && content.some((p) => p.type === "audio");
}

/**
 * Enforce capability gates before a generate call.
 * Throws when the caller passes multimodal parts or a schema the model
 * cannot natively force — callers own the prompt-based JSON fallback (§8.1).
 */
export function assertGenerateCapabilities(
  capabilities: ChatModelCapabilities,
  input: GenerateInput,
): void {
  if (input.schema !== undefined && !capabilities.structuredOutput) {
    throw new Error(
      "generate() was called with a schema but capabilities.structuredOutput is false. " +
        "Callers must fall back to prompt-based JSON + parse (§8.1); loaders do not degrade silently.",
    );
  }
  for (const message of input.messages) {
    if (messageHasImage(message.content) && !capabilities.vision) {
      throw new Error(
        "generate() received image content but capabilities.vision is false.",
      );
    }
    if (messageHasAudio(message.content) && !capabilities.audioInput) {
      throw new Error(
        "generate() received audio content but capabilities.audioInput is false.",
      );
    }
  }
}

export function parseStructuredText(
  text: string,
  schema: ZodType,
): unknown {
  const trimmed = text.trim();
  // Strip common markdown fences some models still emit under JSON mode.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed: unknown = JSON.parse(unfenced);
  return schema.parse(parsed);
}
