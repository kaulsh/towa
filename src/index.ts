/**
 * Public library surface for Towa (§13).
 *
 * Typical daemon consumer:
 *   openDatabase → load* models → createTelegramAdapter (or any ChannelAdapter)
 *   → createHarness(...).start()
 *
 * Also exported: ChannelAdapter + model interface types for custom adapters/loaders.
 * Internal planes (raw-log, retrieval, KG, drain, debounce) are not part of this API.
 */

// Database
export {
  openDatabase,
  type Database,
  type OpenDatabaseOptions,
} from "./db/index.js";

// Models — loaders + the interfaces they satisfy (for custom loaders too)
export type {
  AudioPart,
  ChatMessage,
  ChatModelCapabilities,
  ChatRole,
  GenerateInput,
  GenerateOutput,
  ImagePart,
  LoadedChatModel,
  LoadedEmbeddingModel,
  MessagePart,
  TextPart,
} from "./models/types.js";
export {
  loadOllama,
  loadLlamaCpp,
  loadLocalEmbeddings,
  loadOpenAICompatible,
  loadOpenAICompatibleEmbeddings,
  type OllamaConfig,
  type LlamaCppConfig,
  type LocalEmbeddingsConfig,
  type OpenAICompatibleConfig,
  type OpenAICompatibleEmbeddingsConfig,
} from "./models/loaders/index.js";

// Channel — interface for custom adapters + Telegram v1 implementation
export type {
  ChannelAdapter,
  DeleteEvent,
  EditEvent,
  InboundMessage,
  MediaRef,
  OutboundMessage,
  PresenceEvent,
} from "./channels/adapter.js";
export {
  createTelegramAdapter,
  type TelegramAdapterConfig,
  type TelegramWebhookConfig,
} from "./channels/telegram/index.js";

// Harness — primary runtime entry (§6)
export {
  createHarness,
  type CreateHarnessDeps,
  type Harness,
  type HarnessDebounceOptions,
} from "./core/harness/index.js";
