import type { Kysely } from "kysely";
import pino, { type Logger } from "pino";

import type { ChannelAdapter, InboundMessage } from "../../channels/adapter.js";
import type { Database } from "../../db/types.js";
import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../../models/types.js";
import { loadRecentWorkingTurns } from "../context-assembly/load-turns.js";
import { runRetrievalAndGenerate } from "../retrieval/pipeline.js";
import {
  startDrainWorker,
  type DrainWorkerHandle,
} from "../write-path/drain-worker.js";

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
  channel: ChannelAdapter;
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
  /** Extraction drain model; defaults to `chatModel` (§8.2). */
  extractionModel?: LoadedChatModel;
  systemPrompt?: string;
  debounce?: Partial<HarnessDebounceOptions>;
  /** Passed through to working-context session boundary (§6). */
  sessionIdleThresholdSec?: number;
  logger?: Logger;
}

export interface Harness {
  /** Register handlers, start drain worker, then `channel.start()`. */
  start(): void;
  /** Stop drain + clear debounce. Does not assume `channel.stop()`. */
  stop(): Promise<void>;
}

interface PendingTurn {
  chatId: string;
  messages: InboundMessage[];
}

/**
 * Build user-facing message text for the reply-path generation call.
 * Media binaries are not pushed into this path — durable memory is
 * text/transcript (extraction may enrich later §7.3).
 */
function messageTextForGeneration(
  msg: InboundMessage,
  chatModel: LoadedChatModel,
): string {
  const base = msg.content.trim();
  if (!msg.mediaRef) {
    return base || "(empty message)";
  }

  const { kind } = msg.mediaRef;
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
 * Core agent loop factory (§6, §7.1, §13).
 * Talks only to `ChannelAdapter` — never imports a concrete channel.
 */
export function createHarness(deps: CreateHarnessDeps): Harness {
  const {
    db,
    channel,
    chatModel,
    embeddingModel,
    systemPrompt,
    sessionIdleThresholdSec,
  } = deps;
  const extractionModel = deps.extractionModel ?? chatModel;
  const log = deps.logger ?? pino({ name: "harness" });

  const debounceOpts: HarnessDebounceOptions = {
    idleMs: deps.debounce?.idleMs ?? DEFAULT_DEBOUNCE_IDLE_MS,
    maxWaitMs: deps.debounce?.maxWaitMs ?? DEFAULT_DEBOUNCE_MAX_WAIT_MS,
  };

  let started = false;
  let drain: DrainWorkerHandle | null = null;
  let debounce: BurstDebouncer | null = null;

  let busy = false;
  /** Chat currently inside `handleTurn` (generation in flight). */
  let inflightChatId: string | null = null;
  const pending: PendingTurn[] = [];
  /** Messages that arrived for `inflightChatId` after its turn started. */
  const lateByChat = new Map<string, InboundMessage[]>();

  function enqueueBurst(batched: InboundMessage[]): void {
    if (batched.length === 0) return;
    const chatId = batched[0]!.chatId;

    // Still generating for this chat — fold into the in-flight turn before send.
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

  async function handleTurn(messages: InboundMessage[]): Promise<void> {
    const chatId = messages[0]!.chatId;
    let turnMessages = messages;

    // Sole slash-command bursts stay command-shaped (not joined prose).
    const sole = turnMessages.length === 1 ? turnMessages[0]! : null;
    const soleSlash = sole ? parseSlashCommand(sole.content) : null;

    if (soleSlash?.kind === "start") {
      await channel.send(chatId, {
        type: "text",
        text: START_HELP,
        recordInRawLog: false,
      });
      log.info({ chatId }, "sent /start help");
      return;
    }

    if (soleSlash?.kind === "init_cancel") {
      await cancelInitInterview(db, chatId);
      await channel.send(chatId, {
        type: "text",
        text: "Init interview cancelled. Send /init anytime to start again.",
        recordInRawLog: false,
      });
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
      await channel.send(chatId, { type: "text", text: reply });
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

      await channel.send(chatId, { type: "text", text: reply });
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

    await channel.send(chatId, { type: "text", text: result!.answer });
    log.info({ chatId }, "reply sent");
  }

  async function flushQueue(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (pending.length > 0) {
        const turn = pending.shift()!;
        inflightChatId = turn.chatId;
        try {
          await handleTurn(turn.messages);
        } catch (err) {
          log.error({ err, chatId: turn.chatId }, "turn failed");
          lateByChat.delete(turn.chatId);
          try {
            // Transport-only — must not enter raw_log / working context, or the
            // next turn can parrot the apology as a "successful" answer.
            await channel.send(turn.chatId, {
              type: "text",
              text: "Sorry — I hit an error generating a reply. Try again in a moment.",
              recordInRawLog: false,
            });
          } catch (sendErr) {
            log.error({ err: sendErr }, "failed to send error notice");
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

      log.info("starting extraction drain worker");
      drain = startDrainWorker({
        db,
        chatModel: extractionModel,
        embeddingModel,
        adapter: channel,
        logger: log.child({ component: "drain-worker" }),
      });

      debounce = createBurstDebouncer(debounceOpts);

      channel.onMessage((msg) => {
        log.info({ chatId: msg.chatId }, "inbound message");
        debounce!.schedule(msg.chatId, msg, (batched) => {
          log.info(
            { chatId: batched[0]?.chatId, burstSize: batched.length },
            "debounce flushed — queuing turn",
          );
          enqueueBurst(batched);
          void flushQueue();
        });
      });

      channel.onEdit((edit) => {
        log.info(
          { chatId: edit.chatId, platformMessageId: edit.platformMessageId },
          "inbound edit (raw_log updated; no auto-reply)",
        );
      });

      if (channel.onPresence) {
        channel.onPresence((p) => {
          debounce!.touch(p.chatId);
        });
      }

      log.info("starting channel adapter");
      channel.start();
      log.info(
        {
          chatModel: chatModel.id,
          embeddingModel: embeddingModel.id,
          debounceIdleMs: debounceOpts.idleMs,
          debounceMaxWaitMs: debounceOpts.maxWaitMs,
        },
        "harness started",
      );
    },

    async stop(): Promise<void> {
      debounce?.clearAll();
      debounce = null;
      if (drain) {
        await drain.stop();
        drain = null;
      }
      log.info("harness stopped");
    },
  };
}
