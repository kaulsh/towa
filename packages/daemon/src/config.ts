import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  loadLocalEmbeddings,
  loadOpenAICompatible,
  loadOpenAICompatibleEmbeddings,
  getLogger,
  type LoadedChatModel,
  type LoadedEmbeddingModel,
  type TelegramWebhookConfig,
} from "@towa/core";

import { resolveControlPort } from "./control.js";

const EmbeddingProviderSchema = z.enum(["local", "openai-compatible"]);

const YamlConfigSchema = z.object({
  db: z
    .object({
      path: z.string().min(1).default("./towa.db"),
    })
    .default({ path: "./towa.db" }),
  telegram: z.object({
    chat_id: z.union([z.string(), z.number()]).transform(String),
    webhook: z
      .object({
        domain: z.string().min(1),
        port: z.number().int().positive().optional(),
        path: z.string().optional(),
        host: z.string().optional(),
      })
      .optional(),
  }),
  models: z.object({
    chat: z.object({
      /** OpenAI-compatible model id. */
      model: z.string().min(1),
      /** Required OpenAI-compatible API base URL (no implicit default). */
      base_url: z.string().min(1),
      context_window: z.number().int().positive().optional(),
      vision: z.boolean().default(false),
      /** Telegram voice notes only — music/file audio remain unsupported inbound. */
      voice_note_input: z.boolean().default(false),
    }),
    embedding: z.object({
      provider: EmbeddingProviderSchema.default("local"),
      model: z.string().min(1).optional(),
      dimensions: z.number().int().positive().optional(),
      openai: z
        .object({
          base_url: z.string().min(1),
        })
        .optional(),
    }),
  }),
  harness: z
    .object({
      system_prompt: z.string().nullable().optional(),
      debounce: z
        .object({
          idle_ms: z.number().int().positive().default(800),
          max_wait_ms: z.number().int().positive().default(5000),
        })
        .default({ idle_ms: 800, max_wait_ms: 5000 }),
      session_idle_threshold_sec: z.number().int().positive().default(7200),
    })
    .default({
      debounce: { idle_ms: 800, max_wait_ms: 5000 },
      session_idle_threshold_sec: 7200,
    }),
  drain: z
    .object({
      poll_interval_ms: z.number().int().positive().default(1000),
    })
    .default({ poll_interval_ms: 1000 }),
  logging: z
    .object({
      path: z.string().nullable().optional(),
      max_bytes: z
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024),
      stdout: z.boolean().default(true),
    })
    .default({ max_bytes: 10 * 1024 * 1024, stdout: true }),
  control: z
    .object({
      /** Optional override of the fixed default (§ control.ts). */
      port: z.number().int().positive().optional(),
      token: z.string().optional(),
    })
    .default({}),
});

export type YamlConfig = z.infer<typeof YamlConfigSchema>;

export interface DaemonConfig {
  configFilePath: string;
  dbPath: string;

  telegramBotToken: string;
  telegramChatId: string;
  telegramWebhook?: TelegramWebhookConfig;

  chatModel: string;
  chatContextWindow?: number;
  chatBaseUrl: string;
  chatVision: boolean;
  /** Maps to chat model `capabilities.audioInput` — voice notes only. */
  chatVoiceNoteInput: boolean;
  openaiApiKey?: string;

  embeddingProvider: "local" | "openai-compatible";
  embeddingModel: string;
  embeddingDimensions?: number;
  embeddingBaseUrl?: string;

  debounceIdleMs: number;
  debounceMaxWaitMs: number;
  systemPrompt?: string;
  sessionIdleThresholdSec: number;

  drainPollIntervalMs: number;

  logging: {
    filePath: string;
    maxBytes: number;
    stdout: boolean;
  };

  control: {
    port: number;
    token?: string;
  };
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function resolvePath(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/**
 * Load daemon config from a YAML file + secret env vars.
 * Non-secrets live in YAML; bot token / API keys / tokens come from env.
 */
export function loadConfigFromFile(
  configFilePath: string,
  env: NodeJS.ProcessEnv = process.env,
): DaemonConfig {
  const absoluteConfigPath = resolve(configFilePath);
  const configDir = dirname(absoluteConfigPath);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(absoluteConfigPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to read config file ${absoluteConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const parsed = YamlConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid config file ${absoluteConfigPath}:\n${parsed.error.toString()}`,
    );
  }
  const yaml = parsed.data;

  const dbPath = resolvePath(configDir, yaml.db.path);
  const logPath =
    yaml.logging.path != null && yaml.logging.path.length > 0
      ? resolvePath(configDir, yaml.logging.path)
      : join(dirname(dbPath), "towa.log");

  const embeddingProvider = yaml.models.embedding.provider;
  const chatBaseUrl = yaml.models.chat.base_url.trim();
  const embeddingBaseUrl =
    yaml.models.embedding.openai?.base_url?.trim() || undefined;

  if (embeddingProvider === "openai-compatible" && !embeddingBaseUrl) {
    throw new Error(
      "models.embedding.openai.base_url is required when models.embedding.provider is openai-compatible",
    );
  }
  if (
    embeddingProvider === "openai-compatible" &&
    yaml.models.embedding.dimensions === undefined
  ) {
    throw new Error(
      "models.embedding.dimensions is required when models.embedding.provider is openai-compatible",
    );
  }

  const openaiApiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const controlToken =
    yaml.control.token?.trim() || env.TOWA_CONTROL_TOKEN?.trim() || undefined;

  let telegramWebhook: TelegramWebhookConfig | undefined;
  if (yaml.telegram.webhook) {
    const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
    telegramWebhook = {
      domain: yaml.telegram.webhook.domain,
      port: yaml.telegram.webhook.port,
      path: yaml.telegram.webhook.path,
      host: yaml.telegram.webhook.host,
      secretToken: secret,
    };
  }

  return {
    configFilePath: absoluteConfigPath,
    dbPath,

    telegramBotToken: requireEnv(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: yaml.telegram.chat_id,
    telegramWebhook,

    chatModel: yaml.models.chat.model.trim(),
    chatContextWindow: yaml.models.chat.context_window,
    chatBaseUrl,
    chatVision: yaml.models.chat.vision,
    chatVoiceNoteInput: yaml.models.chat.voice_note_input,
    openaiApiKey,

    embeddingProvider,
    embeddingModel:
      yaml.models.embedding.model?.trim() ||
      (embeddingProvider === "local"
        ? "onnx-community/all-MiniLM-L6-v2-ONNX"
        : "text-embedding-3-small"),
    embeddingDimensions: yaml.models.embedding.dimensions,
    embeddingBaseUrl,

    debounceIdleMs: yaml.harness.debounce.idle_ms,
    debounceMaxWaitMs: yaml.harness.debounce.max_wait_ms,
    systemPrompt: yaml.harness.system_prompt?.trim() || undefined,
    sessionIdleThresholdSec: yaml.harness.session_idle_threshold_sec,

    drainPollIntervalMs: yaml.drain.poll_interval_ms,

    logging: {
      filePath: logPath,
      maxBytes: yaml.logging.max_bytes,
      stdout: yaml.logging.stdout,
    },

    control: {
      port: resolveControlPort({ yamlPort: yaml.control.port, env }),
      token: controlToken,
    },
  };
}

export async function loadModels(cfg: DaemonConfig): Promise<{
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
}> {
  const log = getLogger("daemon-config");

  log.info(
    {
      chatModel: cfg.chatModel,
      baseURL: cfg.chatBaseUrl,
    },
    "loading chat model (openai-compatible)",
  );

  const chatModel = await loadOpenAICompatible({
    model: cfg.chatModel,
    baseURL: cfg.chatBaseUrl,
    apiKey: cfg.openaiApiKey,
    contextWindow: cfg.chatContextWindow,
    vision: cfg.chatVision,
    audioInput: cfg.chatVoiceNoteInput,
  });
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
      baseURL: cfg.embeddingBaseUrl!,
      apiKey: cfg.openaiApiKey,
      dimensions: cfg.embeddingDimensions!,
    });
  } else {
    embeddingModel = await loadLocalEmbeddings({
      model: cfg.embeddingModel || undefined,
      dimensions: cfg.embeddingDimensions,
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
