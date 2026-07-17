import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { encodingForModel, getEncoding, type TiktokenModel } from "js-tiktoken";
import { resolveContextWindow } from "../context-window-registry.js";
import type {
  ChatMessage,
  GenerateInput,
  GenerateOutput,
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../types.js";
import { estimateTokens } from "./estimate-tokens.js";
import {
  assertGenerateCapabilities,
  flattenMessageText,
  parseStructuredText,
} from "./shared.js";

export interface OpenAICompatibleConfig {
  /** Model id as understood by the remote endpoint. */
  model: string;
  /** OpenAI-compatible API base URL. */
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
  /**
   * Optional tiktoken model name for exact-ish counting.
   * When omitted, tries `config.model` then falls back to cl100k_base /
   * the bundled estimator.
   */
  tiktokenModel?: string;
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
      | {
          type: "input_audio";
          input_audio: { data: string; format: "wav" | "mp3" };
        }
    >;

function audioFormatFromMime(mimeType: string): "wav" | "mp3" {
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "wav";
}

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
    } else if (part.type === "audio") {
      parts.push({
        type: "input_audio",
        input_audio: {
          data: part.data.toString("base64"),
          format: audioFormatFromMime(part.mimeType),
        },
      });
    }
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

function countWithTiktoken(modelHint: string, text: string): number | null {
  try {
    const enc = encodingForModel(modelHint as TiktokenModel);
    return enc.encode(text).length;
  } catch {
    try {
      // cl100k_base covers most OpenAI-shaped chat models.
      return getEncoding("cl100k_base").encode(text).length;
    } catch {
      return null;
    }
  }
}

/**
 * Universal remote/server chat escape hatch (§8.2), parameterized by `baseURL`.
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

      if (input.schema !== undefined) {
        const completion = await client.chat.completions.create({
          model: config.model,
          messages: toOpenAIMessages(input.messages),
          response_format: zodResponseFormat(input.schema, "output"),
        });
        const text = completion.choices[0]?.message?.content ?? "";
        try {
          return { text, structured: parseStructuredText(text, input.schema) };
        } catch {
          return { text };
        }
      }

      const completion = await client.chat.completions.create({
        model: config.model,
        messages: toOpenAIMessages(input.messages),
      });
      const text = completion.choices[0]?.message?.content ?? "";
      return { text };
    },
    async countTokens(text: string): Promise<number> {
      const hint = config.tiktokenModel ?? config.model;
      return countWithTiktoken(hint, text) ?? estimateTokens(text);
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
