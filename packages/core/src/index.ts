/**
 * Public library surface for `@towa/core` (§13).
 *
 * Typical daemon consumer:
 *   openDatabase → load* models → createTelegramAdapter (from `@towa/telegram`)
 *   → createHarness(...).start()
 *
 * Also exported: ChannelAdapter + model interface types for custom adapters/loaders,
 * plus a few write-path helpers the Telegram adapter currently needs.
 * Internal planes (retrieval, KG, drain, debounce) are not part of this API.
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

// Channel interface — adapters live in separate packages (e.g. `@towa/telegram`)
export type {
  ChannelAdapter,
  DeleteEvent,
  EditEvent,
  InboundMessage,
  MediaRef,
  OutboundMessage,
  PresenceEvent,
} from "./channels/adapter.js";

// Write-path helpers used by channel adapters (Telegram today)
export {
  appendRawLogEdit,
  appendRawLogMessage,
} from "./core/raw-log/index.js";
export {
  closeEpisode,
  deriveEpisodeBoundary,
} from "./core/episodes/index.js";
export { enqueuePendingExtraction } from "./core/write-path/queue.js";

// Harness — primary runtime entry (§6)
export {
  createHarness,
  type CreateHarnessDeps,
  type Harness,
  type HarnessDebounceOptions,
} from "./core/harness/index.js";
