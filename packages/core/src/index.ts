/**
 * Public library surface for `@towa/core` (§13).
 *
 * Typical daemon consumer:
 *   openDatabase → load* models → createTelegram → createHarness({ db, models, … })
 *   → harness.onTurnCompleted(send via telegram) → daemon poll loop
 *     (startExtractionDrainLoop → runExtraction / queue helpers)
 *   → telegram.start((msg) => harness.handleTurn(msg))
 *
 * Core is library-like: no long-running poll/worker starters. The daemon owns
 * the extraction tick and drain loop; core exports extraction/queue primitives
 * (`runExtraction`, `listResumableExtractions`, …) that the tick composes.
 *
 * Also exported: message types + model interfaces for custom loaders,
 * plus episode/raw-log helpers used by the Telegram runtime / daemon.
 * Internal planes (retrieval, entity resolution internals, debounce) are not
 * part of this API.
 */

// Process-wide logging (§13) — configureLogging once; getLogger everywhere
export {
  configureLogging,
  getLogFilePath,
  getLogger,
  type ConfigureLoggingOptions,
} from "./logging.js";

// Database
export * from "./db/index.js";

// Models — loaders + interfaces + LLM orchestration (query-gen / assess / answer)
export type {
  AudioPart,
  ChatMessage,
  ChatModelCapabilities,
  ChatRole,
  GenerateInput,
  GenerateOutput,
  GenerateUsage,
  ImagePart,
  LoadedChatModel,
  LoadedEmbeddingModel,
  MessagePart,
  TextPart,
  ToolCall,
  ToolDefinition,
} from "./ai/types.js";
export {
  assessMemorySufficiency,
  generateAnswer,
  generateSearchQueries,
  generateStructured,
  loadLocalEmbeddings,
  loadOpenAICompatible,
  loadOpenAICompatibleEmbeddings,
  type AnswerResult,
  type AssessResult,
  type GenerateAnswerInput,
  type HistoryRequest,
  type LocalEmbeddingsConfig,
  type OpenAICompatibleConfig,
  type OpenAICompatibleEmbeddingsConfig,
  type QueryGenResult,
  type StructuredGenerateResult,
} from "./ai/index.js";

// Built-in agent tools (§5.4) — daemon enables subsets via YAML
export {
  buildEnabledTools,
  buildTurnMediaRefs,
  type BuildEnabledToolsInput,
  type ToolExecuteResult,
  type ToolExecutor,
  type ToolTurnContext,
  type TurnMediaRef,
  type WebFetchProvider,
  type WebSearchProvider,
} from "./tools/index.js";

// Shared message shapes (send lives on Telegram; media bytes via process cache)
export type {
  DeleteEvent,
  InboundMessage,
  MediaKind,
  MediaRef,
  OutboundMessage,
  ReplyToRef,
  SendOutbound,
  TurnResult,
} from "./messages.js";
export { durableMediaRef, isMediaKind } from "./messages.js";

// Raw-log / episode helpers used by Telegram outbound durability
export { appendRawLogEdit, appendRawLogMessage } from "./raw-log/index.js";
export { closeEpisode, deriveEpisodeBoundary } from "./raw-log/index.js";

// Extraction + pending_extraction queue primitives (daemon tick composes these)
export {
  runExtraction,
  type RunExtractionDeps,
  enqueuePendingExtraction,
  listPendingExtractions,
  listResumableExtractions,
  type PendingExtractionRow,
} from "./extraction/index.js";

// Harness — programmatic agent controller (§6)
export {
  createHarness,
  type CreateHarnessDeps,
  type Harness,
  type HarnessDebounceOptions,
  type TurnCompletedHandler,
} from "./harness/index.js";

// Telegram runtime — Telegraf wiring; daemon registers inbound (§7)
export {
  Telegram,
  type TelegramConfig,
  type TelegramInboundHandler,
  type TelegramRuntime,
  type TelegramUpload,
  type TelegramWebhookConfig,
} from "./telegram/index.js";
