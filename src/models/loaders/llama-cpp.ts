import { basename } from "node:path";
import { getLlama, LlamaChat, type ChatHistoryItem } from "node-llama-cpp";
import { resolveContextWindow } from "../context-window-registry.js";
import type {
  ChatMessage,
  GenerateInput,
  GenerateOutput,
  LoadedChatModel,
} from "../types.js";
import {
  assertGenerateCapabilities,
  flattenMessageText,
  parseStructuredText,
  zodToJsonSchema,
} from "./shared.js";

export interface LlamaCppConfig {
  /** Path to a local GGUF weight file. */
  modelPath: string;
  /**
   * Public model id for the registry / logs.
   * Defaults to the GGUF filename (without extension).
   */
  id?: string;
  /** Override for `capabilities.contextWindow` (§8.3). */
  contextWindow?: number;
  /** GPU layers to offload; omit to let node-llama-cpp decide. */
  gpuLayers?: number;
  /**
   * Whether JSON-schema grammar forcing is available.
   * Defaults to `true` (node-llama-cpp grammar support).
   */
  structuredOutput?: boolean;
  vision?: boolean;
  audioInput?: boolean;
}

function toChatHistory(messages: ChatMessage[]): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [];

  for (const message of messages) {
    const text = flattenMessageText(message.content);
    if (message.role === "system") {
      history.push({ type: "system", text });
    } else if (message.role === "user") {
      history.push({ type: "user", text });
    } else {
      history.push({ type: "model", response: [text] });
    }
  }

  return history;
}

/**
 * In-process GGUF chat loader via `node-llama-cpp` (§8.2 / §8.4).
 * Model stays resident for the process lifetime — not the default for
 * always-on daemons; prefer `loadOllama` when VRAM/thermal matter.
 */
export async function loadLlamaCpp(
  config: LlamaCppConfig,
): Promise<LoadedChatModel> {
  const id = config.id ?? basename(config.modelPath).replace(/\.gguf$/i, "");

  const contextWindow = resolveContextWindow(id, config.contextWindow);
  const capabilities = {
    structuredOutput: config.structuredOutput ?? true,
    vision: config.vision ?? false,
    audioInput: config.audioInput ?? false,
    contextWindow,
  };

  const llama = await getLlama();
  const llamaModel = await llama.loadModel({
    modelPath: config.modelPath,
    ...(config.gpuLayers !== undefined ? { gpuLayers: config.gpuLayers } : {}),
  });
  const context = await llamaModel.createContext({
    contextSize: Math.min(contextWindow, llamaModel.trainContextSize),
  });
  const sequence = context.getSequence();
  const chat = new LlamaChat({ contextSequence: sequence });

  const model: LoadedChatModel = {
    id,
    capabilities,
    async generate(input: GenerateInput): Promise<GenerateOutput> {
      assertGenerateCapabilities(capabilities, input);

      const history = toChatHistory(input.messages);
      if (history.length === 0) {
        throw new Error("generate() requires at least one message");
      }

      let grammar = undefined;
      if (input.schema !== undefined) {
        // Zod→JSON Schema is structurally compatible with GbnfJsonSchema at
        // runtime; the library's const-generic signature won't accept a
        // dynamically-produced schema without a cast.
        const jsonSchema = zodToJsonSchema(input.schema);
        grammar = await llama.createGrammarForJsonSchema(
          jsonSchema as Parameters<typeof llama.createGrammarForJsonSchema>[0],
        );
      }

      const result = await chat.generateResponse(history, {
        ...(grammar !== undefined ? { grammar } : {}),
      });

      const text = result.response;
      if (input.schema === undefined) {
        return { text };
      }
      return { text, structured: parseStructuredText(text, input.schema) };
    },
    async countTokens(text: string): Promise<number> {
      return llamaModel.tokenize(text).length;
    },
  };

  return model;
}
