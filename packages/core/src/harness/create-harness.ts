import type { Kysely } from "kysely";
import pino, { type Logger } from "pino";

import type {
  InboundMessage,
  OutboundMessage,
  TurnResult,
} from "../messages.js";
import type { Database } from "../db/types.js";
import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../ai/types.js";
import { loadRecentWorkingTurns } from "../context-assembly/load-turns.js";
import { runRetrievalAndGenerate } from "../retrieval/pipeline.js";

import { createBurstDebouncer, type BurstDebouncer } from "./debounce.js";
import {
  cancelInitInterview,
  continueInitInterview,
  loadInitInterviewState,
  saveInitInterviewState,
  startOrResumeInitInterview,
} from "./init-interview.js";
import { parseSlashCommand, START_HELP } from "./slash-commands.js";

/** Idle after last message before firing — long enough for a second thought. */
const DEFAULT_DEBOUNCE_IDLE_MS = 2000;
/** Cap from first message in a burst. */
const DEFAULT_DEBOUNCE_MAX_WAIT_MS = 8000;

export interface HarnessDebounceOptions {
  idleMs: number;
  maxWaitMs: number;
}

export interface CreateHarnessDeps {
  db: Kysely<Database>;
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
  systemPrompt?: string;
  debounce?: Partial<HarnessDebounceOptions>;
  /** Passed through to working-context session boundary (§6). */
  sessionIdleThresholdSec?: number;
  logger?: Logger;
}

export type TurnCompletedHandler = (
  result: TurnResult,
) => void | Promise<void>;

export interface Harness {
  /** Start burst debounce. Does not start Telegram transport or the drain worker. */
  start(): void;
  /** Clear debounce timers. */
  stop(): Promise<void>;
  /**
   * Accept an inbound user message into debounce/queue (variant 1).
   * Resolves when the message is accepted — does **not** wait for generation
   * or delivery. Message should already be persisted to raw_log by Telegram,
   * with ephemeral base64 media on `media.data` when available.
   */
  handleTurn(msg: InboundMessage): Promise<void>;
  /**
   * Register a delivery listener. Fires once per logical turn with outbound
   * messages. Async handlers are awaited before the next queued turn starts
   * (delivery backpressure). Returns an unsubscribe function.
   */
  onTurnCompleted(handler: TurnCompletedHandler): () => void;
}

interface PendingTurn {
  chatId: string;
  messages: InboundMessage[];
}

/**
 * Build user-facing message text for the reply-path generation call.
 * Media binaries may be present on the inbound message; this path still uses
 * text notes only (full multimodal generate from inbound base64 is deferred;
 * extraction enriches later §7.3). Missing bytes get an explicit load-failed note.
 */
function messageTextForGeneration(
  msg: InboundMessage,
  chatModel: LoadedChatModel,
): string {
  const base = msg.content.trim();
  if (!msg.media) {
    return base || "(empty message)";
  }

  const { kind, data } = msg.media;

  // Download failed (or never attempted) — tell the model explicitly.
  if (!data) {
    const note = `[user sent ${kind} media; content could not be loaded]`;
    return base ? `${base}\n${note}` : note;
  }

  // Bytes present but reply path is still text-notes only.
  const needsVision = kind === "image" || kind === "video";
  const needsAudio = kind === "audio";
  const supported =
    (needsVision && chatModel.capabilities.vision) ||
    (needsAudio && chatModel.capabilities.audioInput) ||
    kind === "file";

  if (supported && base) {
    return base;
  }

  const note = `[user sent ${kind} media; content not available in this reply path]`;
  return base ? `${base}\n${note}` : note;
}

/** Join a debounced burst (and any late arrivals) into one generation input. */
function joinBurstText(
  messages: readonly InboundMessage[],
  chatModel: LoadedChatModel,
): string {
  return messages
    .map((m) => messageTextForGeneration(m, chatModel))
    .filter((t) => t.length > 0)
    .join("\n");
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
  } = deps;
  const log = deps.logger ?? pino({ name: "harness" });

  const debounceOpts: HarnessDebounceOptions = {
    idleMs: deps.debounce?.idleMs ?? DEFAULT_DEBOUNCE_IDLE_MS,
    maxWaitMs: deps.debounce?.maxWaitMs ?? DEFAULT_DEBOUNCE_MAX_WAIT_MS,
  };

  let started = false;
  let debounce: BurstDebouncer | null = null;

  let busy = false;
  /** Chat currently inside `runTurn` (generation in flight). */
  let inflightChatId: string | null = null;
  const pending: PendingTurn[] = [];
  /** Messages that arrived for `inflightChatId` after its turn started. */
  const lateByChat = new Map<string, InboundMessage[]>();
  const turnCompletedHandlers: TurnCompletedHandler[] = [];

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

  /** Notify listeners and await them (delivery backpressure before next turn). */
  async function notifyTurnCompleted(result: TurnResult): Promise<void> {
    for (const handler of turnCompletedHandlers) {
      await handler(result);
    }
  }

  async function deliver(
    chatId: string,
    outbound: OutboundMessage[],
  ): Promise<void> {
    await notifyTurnCompleted({ chatId, outbound });
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
        logger: log.child({ component: "init-interview" }),
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
        const answerText = joinBurstText(turnMessages, chatModel);
        reply = await continueInitInterview({
          db,
          chatModel,
          chatId,
          userMessage: answerText,
          logger: log.child({ component: "init-interview" }),
        });
        const next = takeLateArrivals(chatId, turnMessages);
        if (next === turnMessages) break;
        turnMessages = next;
      }

      await deliver(chatId, [{ type: "text", text: reply }]);
      return;
    }

    log.info(
      {
        chatId,
        burstSize: turnMessages.length,
        contentPreview: joinBurstText(turnMessages, chatModel).slice(0, 80),
      },
      "running forced retrieval pipeline",
    );

    let result: Awaited<ReturnType<typeof runRetrievalAndGenerate>> | undefined;
    for (;;) {
      const recentTurns = await loadRecentWorkingTurns(db);
      const message = joinBurstText(turnMessages, chatModel);
      result = await runRetrievalAndGenerate({
        db,
        chatModel,
        embeddingModel,
        message,
        recentTurns,
        systemPrompt,
        sessionIdleThresholdSec,
        logger: log.child({ component: "retrieval" }),
      });
      const next = takeLateArrivals(chatId, turnMessages);
      if (next === turnMessages) break;
      turnMessages = next;
    }

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
    start(): void {
      if (started) {
        throw new Error("createHarness: start() called more than once");
      }
      started = true;

      debounce = createBurstDebouncer(debounceOpts);

      log.info(
        {
          chatModel: chatModel.id,
          embeddingModel: embeddingModel.id,
          debounceIdleMs: debounceOpts.idleMs,
          debounceMaxWaitMs: debounceOpts.maxWaitMs,
        },
        "harness started (awaiting inbound via handleTurn)",
      );
    },

    async stop(): Promise<void> {
      debounce?.clearAll();
      debounce = null;
      started = false;
      log.info("harness stopped");
    },

    async handleTurn(msg: InboundMessage): Promise<void> {
      if (!started || !debounce) {
        throw new Error("createHarness: handleTurn before start()");
      }
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

    onTurnCompleted(handler: TurnCompletedHandler): () => void {
      turnCompletedHandlers.push(handler);
      return () => {
        const idx = turnCompletedHandlers.indexOf(handler);
        if (idx >= 0) turnCompletedHandlers.splice(idx, 1);
      };
    },
  };
}
