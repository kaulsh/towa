import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { resolveContextWindow } from "../context-window-registry.js";
import type {
  ChatMessage,
  GenerateInput,
  GenerateOutput,
  GenerateUsage,
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../types.js";
import { transcribeOpenAICompatible } from "./openai-transcribe.js";
import {
  assertGenerateCapabilities,
  flattenMessageText,
  parseStructuredText,
} from "./shared.js";
import type { MessagePart } from "../types.js";

export interface OpenAICompatibleConfig {
  /** Model id as understood by the remote endpoint. */
  model: string;
  /** OpenAI-compatible API base URL (e.g. Ollama `http://127.0.0.1:11434/v1`). */
  baseURL: string;
  /** API key; many local servers accept any non-empty string. */
  apiKey?: string;
  /** Override for `capabilities.contextWindow` (§8.3). */
  contextWindow?: number;
  /**
   * Whether the endpoint supports forced JSON / json_schema.
   * Defaults to `true` for OpenAI-shaped APIs.
   */
  structuredOutput?: boolean;
  vision?: boolean;
  audioInput?: boolean;
}

export interface OpenAICompatibleEmbeddingsConfig {
  model: string;
  baseURL: string;
  apiKey?: string;
  /** Required embedding dimensionality for this model. */
  dimensions: number;
}

type OpenAIChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image_url";
          image_url: { url: string };
        }
    >;

function toOpenAIContent(content: ChatMessage["content"]): OpenAIChatContent {
  if (typeof content === "string") return content;

  const parts: Exclude<OpenAIChatContent, string> = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const b64 = part.data.toString("base64");
      parts.push({
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${b64}` },
      });
    }
    // Audio parts are handled via /v1/audio/transcriptions in generate(), not chat.
  }
  return parts;
}

function toOpenAIMessages(
  messages: ChatMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    const content = toOpenAIContent(message.content);
    if (message.role === "system") {
      return {
        role: "system",
        content:
          typeof content === "string"
            ? content
            : flattenMessageText(message.content),
      };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content:
          typeof content === "string"
            ? content
            : flattenMessageText(message.content),
      };
    }
    return { role: "user", content };
  });
}

function usageFromCompletion(
  usage: OpenAI.Completions.CompletionUsage | null | undefined,
): GenerateUsage | undefined {
  if (!usage) return undefined;
  const out: GenerateUsage = {};
  if (typeof usage.prompt_tokens === "number") {
    out.promptTokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    out.completionTokens = usage.completion_tokens;
  }
  return out.promptTokens !== undefined || out.completionTokens !== undefined
    ? out
    : undefined;
}

function collectAudioParts(
  messages: readonly ChatMessage[],
): Extract<MessagePart, { type: "audio" }>[] {
  const out: Extract<MessagePart, { type: "audio" }>[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "audio") out.push(part);
    }
  }
  return out;
}

/**
 * Sole chat loader (§8.2) — OpenAI-compatible HTTP, including Ollama `/v1`.
 */
export async function loadOpenAICompatible(
  config: OpenAICompatibleConfig,
): Promise<LoadedChatModel> {
  const client = new OpenAI({
    apiKey: config.apiKey ?? "not-needed",
    baseURL: config.baseURL,
  });

  const contextWindow = resolveContextWindow(
    config.model,
    config.contextWindow,
  );
  const capabilities = {
    structuredOutput: config.structuredOutput ?? true,
    vision: config.vision ?? false,
    audioInput: config.audioInput ?? false,
    contextWindow,
  };

  const model: LoadedChatModel = {
    id: config.model,
    capabilities,
    async generate(input: GenerateInput): Promise<GenerateOutput> {
      assertGenerateCapabilities(capabilities, input);

      // Voice transcription via /v1/audio/transcriptions.
      const audioParts = collectAudioParts(input.messages);
      if (audioParts.length > 0) {
        const transcripts: string[] = [];

        for (const part of audioParts) {
          const transcribed = await transcribeOpenAICompatible({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            model: config.model,
            data: part.data,
            mimeType: part.mimeType,
          });
          transcripts.push(transcribed);
        }

        const text = transcripts.filter((t) => t.length > 0).join("\n\n");

        if (input.schema === undefined) {
          return { text };
        }
        try {
          return { text, structured: parseStructuredText(text, input.schema) };
        } catch {
          return { text };
        }
      }

      if (input.schema !== undefined) {
        const completion = await client.chat.completions.create({
          model: config.model,
          messages: toOpenAIMessages(input.messages),
          response_format: zodResponseFormat(input.schema, "output"),
        });

        const text = completion.choices[0]?.message?.content ?? "";

        const usage = usageFromCompletion(completion.usage);

        try {
          return {
            text,
            structured: parseStructuredText(text, input.schema),
            ...(usage ? { usage } : {}),
          };
        } catch {
          return { text, ...(usage ? { usage } : {}) };
        }
      }

      const completion = await client.chat.completions.create({
        model: config.model,
        messages: toOpenAIMessages(input.messages),
      });

      const text = completion.choices[0]?.message?.content ?? "";

      const usage = usageFromCompletion(completion.usage);

      return { text, ...(usage ? { usage } : {}) };
    },
  };

  return model;
}

/**
 * OpenAI-compatible embeddings escape hatch (§8.2).
 */
export async function loadOpenAICompatibleEmbeddings(
  config: OpenAICompatibleEmbeddingsConfig,
): Promise<LoadedEmbeddingModel> {
  const client = new OpenAI({
    apiKey: config.apiKey ?? "not-needed",
    baseURL: config.baseURL,
  });

  const model: LoadedEmbeddingModel = {
    id: config.model,
    dimensions: config.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const response = await client.embeddings.create({
        model: config.model,
        input: texts,
      });
      // API may return rows out of order; sort by index.
      const vectors = [...response.data]
        .sort((a, b) => a.index - b.index)
        .map((row) => row.embedding);

      for (const vector of vectors) {
        if (vector.length !== config.dimensions) {
          throw new Error(
            `Embedding dimension mismatch for "${config.model}": ` +
              `expected ${config.dimensions}, got ${vector.length}`,
          );
        }
      }
      return vectors;
    },
  };

  return model;
}
