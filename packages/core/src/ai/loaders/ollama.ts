import { Ollama, type Message } from "ollama";
import { resolveContextWindow } from "../context-window-registry.js";
import { getLogger } from "../../logging.js";
import type {
  ChatMessage,
  GenerateInput,
  GenerateOutput,
  LoadedChatModel,
  MessagePart,
} from "../types.js";
import { estimateTokens } from "./estimate-tokens.js";
import { transcribeOpenAICompatible } from "./openai-transcribe.js";
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
  /**
   * Voice-note transcription via OpenAI-compatible `/v1/audio/transcriptions`
   * (e.g. Gemma4). No host ffmpeg — audio file uploads are unsupported inbound.
   */
  audioInput?: boolean;
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
 * Map Towa chat messages to Ollama's chat API shape.
 * Vision: image parts → `message.images`. Audio is handled separately via
 * `/v1/audio/transcriptions` (not the images field).
 */
function toOllamaMessages(messages: ChatMessage[]): Message[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }

    const text = flattenMessageText(message.content);
    const images: Uint8Array[] = message.content
      .filter(
        (p): p is Extract<MessagePart, { type: "image" }> => p.type === "image",
      )
      .map((p) => new Uint8Array(p.data));

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
export async function loadOllama(
  config: OllamaConfig,
): Promise<LoadedChatModel> {
  const host = config.host ?? "http://127.0.0.1:11434";
  const log = getLogger("ollama");
  const client = new Ollama({ host });
  const pullIfMissing = config.pullIfMissing ?? true;

  log.info({ host, model: config.model }, "checking Ollama for model");

  let present: boolean;
  try {
    present = await modelIsPresent(client, config.model);
  } catch (err) {
    log.error(
      { err, host, model: config.model },
      "failed to reach Ollama — is `ollama serve` running?",
    );
    throw new Error(
      `loadOllama: cannot reach Ollama at ${host} (model ${config.model}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (present) {
    log.info({ host, model: config.model }, "Ollama model present");
  } else if (pullIfMissing) {
    log.info(
      { host, model: config.model },
      "Ollama model missing — starting pull (may take a while)",
    );
    try {
      await client.pull({ model: config.model });
    } catch (err) {
      log.error({ err, host, model: config.model }, "Ollama model pull failed");
      throw new Error(
        `loadOllama: pull failed for ${config.model} at ${host}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    log.info({ host, model: config.model }, "Ollama model pull complete");
  } else {
    throw new Error(
      `loadOllama: model ${config.model} not present at ${host} and pullIfMissing=false`,
    );
  }

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

      // Voice notes: OpenAI-compatible transcriptions API (no ffmpeg / images hack).
      const audioParts = collectAudioParts(input.messages);
      if (audioParts.length > 0) {
        const transcripts: string[] = [];
        for (const part of audioParts) {
          const transcribed = await transcribeOpenAICompatible({
            baseURL: `${host.replace(/\/+$/, "")}/v1`,
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
      // If the model ignores `format` (common when the prompt says "yes/no"),
      // return text only so generateStructured can run its JSON repair retry.
      try {
        return { text, structured: parseStructuredText(text, input.schema) };
      } catch {
        return { text };
      }
    },
    async countTokens(text: string): Promise<number> {
      const exact = await tryTokenize(host, config.model, text);
      return exact ?? estimateTokens(text);
    },
  };

  log.info(
    { host, model: config.model, contextWindow },
    "Ollama chat model loaded",
  );
  return model;
}
