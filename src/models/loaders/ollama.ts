import { Ollama, type Message } from "ollama";
import { resolveContextWindow } from "../context-window-registry.js";
import type {
  ChatMessage,
  GenerateInput,
  GenerateOutput,
  LoadedChatModel,
  MessagePart,
} from "../types.js";
import { estimateTokens } from "./estimate-tokens.js";
import {
  assertGenerateCapabilities,
  flattenMessageText,
  parseStructuredText,
  zodToJsonSchema,
} from "./shared.js";

export interface OllamaConfig {
  /** Ollama model name, e.g. `llama3.1:8b`. */
  model: string;
  /** Ollama server base URL. Defaults to `http://127.0.0.1:11434`. */
  host?: string;
  /** Override for `capabilities.contextWindow` (§8.3). */
  contextWindow?: number;
  /** Auto-pull the model if missing. Defaults to `true`. */
  pullIfMissing?: boolean;
  /**
   * Whether the model/API path supports forced JSON (`format`).
   * Defaults to `true` — Ollama's `format` option is widely available.
   */
  structuredOutput?: boolean;
  vision?: boolean;
  audioInput?: boolean;
}

function toOllamaMessages(messages: ChatMessage[]): Message[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }

    const text = flattenMessageText(message.content);
    const images = message.content
      .filter((p): p is Extract<MessagePart, { type: "image" }> => p.type === "image")
      .map((p) => p.data);

    const out: Message = { role: message.role, content: text };
    if (images.length > 0) {
      out.images = images;
    }
    return out;
  });
}

async function modelIsPresent(client: Ollama, model: string): Promise<boolean> {
  const listed = await client.list();
  return listed.models.some((m) => {
    const name = m.name || m.model;
    return (
      name === model ||
      name.startsWith(`${model}:`) ||
      model.startsWith(`${name}`)
    );
  });
}

/**
 * Try Ollama's `/api/tokenize` endpoint; return null when unavailable.
 */
async function tryTokenize(
  host: string,
  model: string,
  text: string,
): Promise<number | null> {
  try {
    const response = await fetch(new URL("/api/tokenize", host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tokens?: unknown };
    if (!Array.isArray(body.tokens)) return null;
    return body.tokens.length;
  } catch {
    return null;
  }
}

/**
 * Default chat + extraction loader (§8.2 / §8.4).
 * Ollama owns model residency (load on request, unload on idle).
 */
export async function loadOllama(config: OllamaConfig): Promise<LoadedChatModel> {
  const host = config.host ?? "http://127.0.0.1:11434";
  const client = new Ollama({ host });
  const pullIfMissing = config.pullIfMissing ?? true;

  if (pullIfMissing && !(await modelIsPresent(client, config.model))) {
    await client.pull({ model: config.model });
  }

  const contextWindow = resolveContextWindow(config.model, config.contextWindow);
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

      const format =
        input.schema !== undefined ? zodToJsonSchema(input.schema) : undefined;

      const response = await client.chat({
        model: config.model,
        messages: toOllamaMessages(input.messages),
        stream: false,
        ...(format !== undefined ? { format } : {}),
      });

      const text = response.message.content ?? "";
      if (input.schema === undefined) {
        return { text };
      }
      return { text, structured: parseStructuredText(text, input.schema) };
    },
    async countTokens(text: string): Promise<number> {
      const exact = await tryTokenize(host, config.model, text);
      return exact ?? estimateTokens(text);
    },
  };

  return model;
}
