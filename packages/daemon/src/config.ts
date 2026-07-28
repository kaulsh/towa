import pino from "pino";
import {
  loadLocalEmbeddings,
  loadOllama,
  loadOpenAICompatible,
  loadOpenAICompatibleEmbeddings,
  type LoadedChatModel,
  type LoadedEmbeddingModel,
} from "@towa/core";

const log = pino({ name: "daemon-config" });

export interface DaemonConfig {
  telegramBotToken: string;
  telegramChatId: string;
  dbPath: string;

  chatProvider: "ollama" | "openai-compatible";
  chatModel: string;
  chatContextWindow?: number;
  ollamaHost?: string;
  /** When true, image parts are sent via the provider vision path (§7.3 / §8.1). */
  chatVision: boolean;
  /** When true, audio parts are accepted for multimodal generate (§7.3 / §8.1). */
  chatAudioInput: boolean;

  openaiBaseUrl?: string;
  openaiApiKey?: string;

  embeddingProvider: "local" | "openai-compatible";
  embeddingModel: string;
  embeddingDimensions?: number;

  debounceIdleMs: number;
  debounceMaxWaitMs: number;
  systemPrompt?: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optionalInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env ${key} must be a number, got: ${raw}`);
  }
  return Math.trunc(n);
}

/** Parse `1`/`true`/`yes` as true; unset defaults to `defaultValue`. */
function optionalBool(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: boolean,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  throw new Error(`Env ${key} must be a boolean, got: ${env[key]}`);
}

/**
 * Read daemon config from process.env (after dotenv load).
 * Defaults favor local Ollama chat + local MiniLM embeddings.
 */
export function loadConfig(env: NodeJS.ProcessEnv): DaemonConfig {
  const chatProvider =
    (env.TOWA_CHAT_PROVIDER?.trim() as
      | DaemonConfig["chatProvider"]
      | undefined) ?? "ollama";
  if (chatProvider !== "ollama" && chatProvider !== "openai-compatible") {
    throw new Error(
      `TOWA_CHAT_PROVIDER must be "ollama" or "openai-compatible", got: ${chatProvider}`,
    );
  }

  const embeddingProvider =
    (env.TOWA_EMBEDDING_PROVIDER?.trim() as
      | DaemonConfig["embeddingProvider"]
      | undefined) ?? "local";
  if (
    embeddingProvider !== "local" &&
    embeddingProvider !== "openai-compatible"
  ) {
    throw new Error(
      `TOWA_EMBEDDING_PROVIDER must be "local" or "openai-compatible", got: ${embeddingProvider}`,
    );
  }

  const openaiBaseUrl = env.OPENAI_BASE_URL?.trim();
  const openaiApiKey = env.OPENAI_API_KEY?.trim();

  if (chatProvider === "openai-compatible" && !openaiBaseUrl) {
    throw new Error(
      "OPENAI_BASE_URL is required when TOWA_CHAT_PROVIDER=openai-compatible",
    );
  }
  if (embeddingProvider === "openai-compatible" && !openaiBaseUrl) {
    throw new Error(
      "OPENAI_BASE_URL is required when TOWA_EMBEDDING_PROVIDER=openai-compatible",
    );
  }

  const embeddingDimensions = optionalInt(env, "TOWA_EMBEDDING_DIMENSIONS");
  if (
    embeddingProvider === "openai-compatible" &&
    embeddingDimensions === undefined
  ) {
    throw new Error(
      "TOWA_EMBEDDING_DIMENSIONS is required when TOWA_EMBEDDING_PROVIDER=openai-compatible",
    );
  }

  return {
    dbPath: env.TOWA_DB_PATH?.trim() || "./towa.db",

    telegramBotToken: requireEnv(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv(env, "TELEGRAM_CHAT_ID"),

    chatProvider,
    chatModel:
      env.TOWA_CHAT_MODEL?.trim() ||
      (chatProvider === "ollama" ? "llama3.1:8b" : "gpt-4o-mini"),
    chatContextWindow: optionalInt(env, "TOWA_CHAT_CONTEXT_WINDOW"),
    ollamaHost: env.OLLAMA_HOST?.trim() || undefined,
    chatVision: optionalBool(env, "TOWA_CHAT_VISION", false),
    chatAudioInput: optionalBool(env, "TOWA_CHAT_AUDIO_INPUT", false),

    openaiBaseUrl,
    openaiApiKey,

    embeddingProvider,
    embeddingModel:
      env.TOWA_EMBEDDING_MODEL?.trim() ||
      (embeddingProvider === "local"
        ? "onnx-community/all-MiniLM-L6-v2-ONNX"
        : "text-embedding-3-small"),
    embeddingDimensions,

    debounceIdleMs: optionalInt(env, "TOWA_DEBOUNCE_IDLE_MS") ?? 800,
    debounceMaxWaitMs: optionalInt(env, "TOWA_DEBOUNCE_MAX_WAIT_MS") ?? 5000,
    systemPrompt: env.TOWA_SYSTEM_PROMPT?.trim() || undefined,
  };
}

export async function loadModels(cfg: DaemonConfig): Promise<{
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
}> {
  log.info(
    {
      chatProvider: cfg.chatProvider,
      chatModel: cfg.chatModel,
      ollamaHost: cfg.ollamaHost ?? "http://127.0.0.1:11434",
    },
    "loading chat model",
  );

  let chatModel: LoadedChatModel;
  if (cfg.chatProvider === "openai-compatible") {
    chatModel = await loadOpenAICompatible({
      model: cfg.chatModel,
      baseURL: cfg.openaiBaseUrl!,
      apiKey: cfg.openaiApiKey,
      contextWindow: cfg.chatContextWindow,
      vision: cfg.chatVision,
      audioInput: cfg.chatAudioInput,
    });
  } else {
    chatModel = await loadOllama({
      model: cfg.chatModel,
      host: cfg.ollamaHost,
      contextWindow: cfg.chatContextWindow,
      vision: cfg.chatVision,
      audioInput: cfg.chatAudioInput,
      logger: log.child({ component: "ollama" }),
    });
  }
  log.info({ chatModel: chatModel.id }, "chat model ready");

  log.info(
    {
      embeddingProvider: cfg.embeddingProvider,
      embeddingModel: cfg.embeddingModel,
    },
    "loading embedding model",
  );

  let embeddingModel: LoadedEmbeddingModel;
  if (cfg.embeddingProvider === "openai-compatible") {
    embeddingModel = await loadOpenAICompatibleEmbeddings({
      model: cfg.embeddingModel,
      baseURL: cfg.openaiBaseUrl!,
      apiKey: cfg.openaiApiKey,
      dimensions: cfg.embeddingDimensions!,
    });
  } else {
    embeddingModel = await loadLocalEmbeddings({
      model: cfg.embeddingModel || undefined,
      dimensions: cfg.embeddingDimensions,
      logger: log.child({ component: "local-embeddings" }),
    });
  }
  log.info(
    {
      embeddingModel: embeddingModel.id,
      dimensions: embeddingModel.dimensions,
    },
    "embedding model ready",
  );

  return { chatModel, embeddingModel };
}
