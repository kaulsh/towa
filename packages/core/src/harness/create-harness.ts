import type { Kysely } from "kysely";

import type {
  InboundMessage,
  OutboundMessage,
  TurnResult,
} from "../messages.js";
import type { Database } from "../db/types.js";
import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
  ToolDefinition,
} from "../ai/types.js";
import {
  loadRecentWorkingTurns,
  nextPackingHeadroomState,
  type PackingHeadroomState,
} from "../context-assembly/index.js";
import { captionAndPersistInboundMedia } from "../ai/media/index.js";
import { getLogger } from "../logging.js";
import { runPipeline, type RunPipelineResult } from "./pipeline.js";
import { buildTurnMediaRefs } from "../tools/index.js";
import type { ToolExecutor } from "../tools/types.js";

import {
  createBurstDebouncer,
  type BurstDebouncerOptions,
} from "./debounce.js";
import {
  cancelInitInterview,
  continueInitInterview,
  loadInitInterviewState,
  saveInitInterviewState,
  startOrResumeInitInterview,
} from "./init-interview.js";
import { buildUserTurnContent } from "./user-turn-content.js";

/** Idle after last message before firing — long enough for a second thought. */
const DEFAULT_DEBOUNCE_IDLE_MS = 2000;
/** Cap from first message in a burst. */
const DEFAULT_DEBOUNCE_MAX_WAIT_MS = 8000;

export type HarnessDebounceOptions = BurstDebouncerOptions;

export interface CreateHarnessDeps {
  db: Kysely<Database>;
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
  systemPrompt?: string;
  /** When omitted, harness defaults apply. When present, both fields required. */
  debounce?: BurstDebouncerOptions;
  /** Passed through to working-context session boundary (§6). */
  sessionIdleThresholdSec?: number;
  /** Enabled built-in tools for answer generate (§5.4). */
  tools?: ToolDefinition[];
  toolExecutors?: ReadonlyMap<string, ToolExecutor>;
}

export type TurnCompletedHandler = (result: TurnResult) => void | Promise<void>;

export interface Harness {
  /** Clear debounce timers. */
  clear(): void;
  /**
   * Accept an inbound user message into debounce/queue (variant 1).
   * Resolves when the message is accepted — does **not** wait for generation
   * or delivery. Message should already be persisted to raw_log by Telegram,
   * with ephemeral base64 media on `media.data` when available.
   */
  handleTurn(msg: InboundMessage): Promise<void>;
  /**
   * Set the delivery listener (replaces any prior). Fires once per logical
   * turn with outbound messages. Async handlers are awaited before the next
   * queued turn starts (delivery backpressure).
   */
  onTurnCompleted(handler: TurnCompletedHandler): void;
}

interface PendingTurn {
  chatId: string;
  messages: InboundMessage[];
}

type ParsedSlashCommand =
  | { kind: "start" }
  | { kind: "init" }
  | { kind: "init_cancel" };

const START_HELP = [
  "Talk to me like a normal conversation — I remember durable personal details over time.",
  "",
  "Commands:",
  "  /init — short adaptive interview to capture useful facts about you",
  "  /init cancel — stop an in-progress init interview",
].join("\n");

/**
 * Parse a leading slash command. Normalizes `/cmd@BotName` → `/cmd`.
 * Returns null when the text is not a recognized harness command.
 */
function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const match = /^\/([^\s@]+)(?:@\S+)?(?:\s+(.*))?$/s.exec(trimmed);
  if (!match) return null;

  const cmd = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();

  if (cmd === "start") return { kind: "start" };
  if (cmd === "init") {
    if (args.toLowerCase() === "cancel") return { kind: "init_cancel" };
    return { kind: "init" };
  }
  return null;
}

function collectTurnMediaRefs(messages: readonly InboundMessage[]) {
  const items: Array<{
    data: Buffer;
    mimeType: string;
    kind: string;
    fileName?: string;
  }> = [];
  for (const msg of messages) {
    const media = msg.media;
    if (!media?.data) continue;
    items.push({
      data: Buffer.from(media.data, "base64"),
      mimeType: media.mimeType,
      kind: media.kind,
      ...(media.fileName !== undefined ? { fileName: media.fileName } : {}),
    });
  }
  return buildTurnMediaRefs(items);
}

/**
 * Programmatic agent-loop factory (§6, §7).
 * Callers (daemon / Telegram handlers) invoke harness methods; the harness
 * does not register channel callbacks, own transport, or run the drain worker.
 * Outbound delivery is via `onTurnCompleted` — no injected `send`.
 */
export function createHarness(deps: CreateHarnessDeps): Harness {
  const {
    db,
    chatModel,
    embeddingModel,
    systemPrompt,
    sessionIdleThresholdSec,
    tools,
    toolExecutors,
  } = deps;
  const log = getLogger("harness");

  const debounceOpts: BurstDebouncerOptions = deps.debounce ?? {
    idleMs: DEFAULT_DEBOUNCE_IDLE_MS,
    maxWaitMs: DEFAULT_DEBOUNCE_MAX_WAIT_MS,
  };

  const debounce = createBurstDebouncer(debounceOpts);

  let busy = false;
  /** Chat currently inside `runTurn` (generation in flight). */
  let inflightChatId: string | null = null;
  const pending: PendingTurn[] = [];
  /** Messages that arrived for `inflightChatId` after its turn started. */
  const lateByChat = new Map<string, InboundMessage[]>();
  let turnCompletedHandler: TurnCompletedHandler | null = null;
  /** Usage-relative headroom state per chat (§6). */
  const headroomByChat = new Map<string, PackingHeadroomState>();

  function enqueueBurst(batched: InboundMessage[]): void {
    if (batched.length === 0) return;
    const chatId = batched[0]!.chatId;

    // Still generating for this chat — fold into the in-flight turn before deliver.
    if (busy && inflightChatId === chatId) {
      const late = lateByChat.get(chatId) ?? [];
      late.push(...batched);
      lateByChat.set(chatId, late);
      log.info(
        { chatId, lateCount: late.length, added: batched.length },
        "burst held as late arrivals for in-flight turn",
      );
      return;
    }

    // Merge into an already-queued turn for the same chat.
    const last = pending[pending.length - 1];
    if (last && last.chatId === chatId) {
      last.messages.push(...batched);
      log.info(
        { chatId, burstSize: last.messages.length },
        "merged burst into pending turn",
      );
      return;
    }

    pending.push({ chatId, messages: [...batched] });
  }

  /**
   * Take late arrivals (if any) and return an extended message list.
   * Caller regenerates when the list grows.
   */
  function takeLateArrivals(
    chatId: string,
    messages: InboundMessage[],
  ): InboundMessage[] {
    const late = lateByChat.get(chatId);
    if (!late?.length) return messages;
    lateByChat.delete(chatId);
    log.info(
      { chatId, lateCount: late.length },
      "folding late arrivals into turn — regenerating",
    );
    return [...messages, ...late];
  }

  async function deliver(
    chatId: string,
    outbound: OutboundMessage[],
  ): Promise<void> {
    if (turnCompletedHandler) {
      await turnCompletedHandler({ chatId, outbound });
    }
  }

  async function runTurn(messages: InboundMessage[]): Promise<void> {
    const chatId = messages[0]!.chatId;
    let turnMessages = messages;

    // Sole slash-command bursts stay command-shaped (not joined prose).
    const sole = turnMessages.length === 1 ? turnMessages[0]! : null;
    const soleSlash = sole ? parseSlashCommand(sole.content) : null;

    if (soleSlash?.kind === "start") {
      await deliver(chatId, [
        {
          type: "text",
          text: START_HELP,
          recordInRawLog: false,
        },
      ]);
      log.info({ chatId }, "queued /start help");
      return;
    }

    if (soleSlash?.kind === "init_cancel") {
      await cancelInitInterview(db, chatId);
      await deliver(chatId, [
        {
          type: "text",
          text: "Init interview cancelled. Send /init anytime to start again.",
          recordInRawLog: false,
        },
      ]);
      log.info({ chatId }, "init interview cancelled");
      return;
    }

    if (soleSlash?.kind === "init") {
      log.info({ chatId }, "starting/resuming init interview");
      const reply = await startOrResumeInitInterview({
        db,
        chatModel,
        chatId,
      });
      await deliver(chatId, [{ type: "text", text: reply }]);
      return;
    }

    const interview = await loadInitInterviewState(db, chatId);

    if (interview.status === "active") {
      log.info(
        {
          chatId,
          turnCount: interview.turnCount,
          burstSize: turnMessages.length,
        },
        "init interview answer turn",
      );

      // Snapshot so late-arrival regenerates don't double-count turn_count / goals.
      const stateBefore = await loadInitInterviewState(db, chatId);
      let reply = "";
      let attempt = 0;

      for (;;) {
        if (attempt > 0) {
          await saveInitInterviewState(db, stateBefore);
        }
        attempt += 1;
        const answerText = buildUserTurnContent(turnMessages, chatModel).text;
        reply = await continueInitInterview({
          db,
          chatModel,
          chatId,
          userMessage: answerText,
        });
        const next = takeLateArrivals(chatId, turnMessages);
        if (next === turnMessages) break;
        turnMessages = next;
      }

      await deliver(chatId, [{ type: "text", text: reply }]);
      return;
    }

    const hasInboundMedia = turnMessages.some((m) => Boolean(m.media));
    let mediaArtifacts: ReadonlyMap<string, string> | undefined;

    if (hasInboundMedia) {
      log.info(
        { chatId, burstSize: turnMessages.length },
        "sync media caption before reply",
      );
      const captioned = await captionAndPersistInboundMedia(
        db,
        turnMessages,
        chatModel,
      );
      mediaArtifacts = captioned.artifactsByMessageId;
      log.info(
        {
          chatId,
          artifactCount: captioned.artifactsByMessageId.size,
          appended: captioned.appended,
        },
        "sync media caption done",
      );
    }

    log.info(
      {
        chatId,
        burstSize: turnMessages.length,
      },
      "running forced retrieval pipeline",
    );

    let result: RunPipelineResult | undefined;

    do {
      const recentTurns = await loadRecentWorkingTurns(db);
      const turn = buildUserTurnContent(
        turnMessages,
        chatModel,
        mediaArtifacts,
      );

      result = await runPipeline({
        db,
        chatModel,
        embeddingModel,
        message: turn.text,
        mediaParts: turn.mediaParts,
        recentTurns,
        systemPrompt,
        headroomState: headroomByChat.get(chatId),
        sessionIdleThresholdSec,
        tools,
        toolExecutors,
        turnMediaRefs: collectTurnMediaRefs(turnMessages),
      });

      const nextHeadroom = nextPackingHeadroomState(
        headroomByChat.get(chatId),
        result.promptTokens,
        result.packingTightened,
      );
      if (nextHeadroom !== undefined) {
        headroomByChat.set(chatId, nextHeadroom);
      }

      const next = takeLateArrivals(chatId, turnMessages);
      if (next === turnMessages) break;
      turnMessages = next;

      // Late arrivals may include new media — re-caption before regenerating.
      if (next.some((m) => Boolean(m.media))) {
        const captioned = await captionAndPersistInboundMedia(
          db,
          turnMessages,
          chatModel,
        );
        mediaArtifacts = captioned.artifactsByMessageId;
      }
    } while (true);

    log.info(
      {
        roundsUsed: result!.roundsUsed,
        answerLen: result!.answer.length,
        answerPreview: result!.answer.slice(0, 120),
      },
      "generation complete",
    );

    await deliver(chatId, [{ type: "text", text: result!.answer }]);
    log.info({ chatId }, "turn completed — outbound delivered to listeners");
  }

  async function flushQueue(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (pending.length > 0) {
        const turn = pending.shift()!;
        inflightChatId = turn.chatId;
        try {
          await runTurn(turn.messages);
        } catch (err) {
          log.error({ err, chatId: turn.chatId }, "turn failed");
          lateByChat.delete(turn.chatId);
          try {
            // Transport-only — must not enter raw_log / working context, or the
            // next turn can parrot the apology as a "successful" answer.
            await deliver(turn.chatId, [
              {
                type: "text",
                text: "Sorry — I hit an error generating a reply. Try again in a moment.",
                recordInRawLog: false,
              },
            ]);
          } catch (deliverErr) {
            log.error({ err: deliverErr }, "failed to deliver error notice");
          }
        } finally {
          inflightChatId = null;
        }
      }
    } finally {
      busy = false;
      if (pending.length > 0) {
        void flushQueue();
      }
    }
  }

  return {
    clear(): void {
      debounce.clearAll();
      log.info("harness timers cleared");
    },

    async handleTurn(msg: InboundMessage): Promise<void> {
      log.info(
        {
          chatId: msg.chatId,
          hasMedia: Boolean(msg.media),
          hasMediaBytes: Boolean(msg.media?.data),
        },
        "inbound message accepted into debounce",
      );
      debounce.schedule(msg.chatId, msg, (batched) => {
        log.info(
          { chatId: batched[0]?.chatId, burstSize: batched.length },
          "debounce flushed — queuing turn",
        );
        enqueueBurst(batched);
        void flushQueue();
      });
    },

    onTurnCompleted(handler: TurnCompletedHandler): void {
      turnCompletedHandler = handler;
    },
  };
}
