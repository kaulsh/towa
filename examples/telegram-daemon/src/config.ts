export interface DaemonConfig {
  telegramBotToken: string;
  telegramChatId: string;
  dbPath: string;

  chatProvider: "ollama" | "openai-compatible";
  chatModel: string;
  chatContextWindow?: number;
  ollamaHost?: string;

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

/**
 * Read daemon config from process.env (after dotenv load).
 * Defaults favor local Ollama chat + local MiniLM embeddings.
 */
export function loadConfig(env: NodeJS.ProcessEnv): DaemonConfig {
  const chatProvider =
    (env.TOWA_CHAT_PROVIDER?.trim() as DaemonConfig["chatProvider"] | undefined) ??
    "ollama";
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
  if (embeddingProvider === "openai-compatible" && embeddingDimensions === undefined) {
    throw new Error(
      "TOWA_EMBEDDING_DIMENSIONS is required when TOWA_EMBEDDING_PROVIDER=openai-compatible",
    );
  }

  return {
    telegramBotToken: requireEnv(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv(env, "TELEGRAM_CHAT_ID"),
    dbPath: env.TOWA_DB_PATH?.trim() || "./towa.db",

    chatProvider,
    chatModel:
      env.TOWA_CHAT_MODEL?.trim() ||
      (chatProvider === "ollama" ? "llama3.1:8b" : "gpt-4o-mini"),
    chatContextWindow: optionalInt(env, "TOWA_CHAT_CONTEXT_WINDOW"),
    ollamaHost: env.OLLAMA_HOST?.trim() || undefined,

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
