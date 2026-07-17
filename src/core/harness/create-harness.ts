import type { Kysely } from "kysely";
import pino, { type Logger } from "pino";

import type {
  ChannelAdapter,
  InboundMessage,
} from "../../channels/adapter.js";
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

import {
  createBurstDebouncer,
  type BurstDebouncer,
} from "./debounce.js";

const DEFAULT_DEBOUNCE_IDLE_MS = 800;
const DEFAULT_DEBOUNCE_MAX_WAIT_MS = 5000;

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
  const pending: InboundMessage[] = [];

  async function handleTurn(msg: InboundMessage): Promise<void> {
    const recentTurns = await loadRecentWorkingTurns(db);
    const message = messageTextForGeneration(msg, chatModel);

    log.info(
      { chatId: msg.chatId, contentPreview: message.slice(0, 80) },
      "running forced retrieval pipeline",
    );

    const result = await runRetrievalAndGenerate({
      db,
      chatModel,
      embeddingModel,
      message,
      recentTurns,
      systemPrompt,
      sessionIdleThresholdSec,
      logger: log.child({ component: "retrieval" }),
    });

    log.info(
      {
        roundsUsed: result.roundsUsed,
        answerLen: result.answer.length,
        answerPreview: result.answer.slice(0, 120),
      },
      "generation complete",
    );

    await channel.send(msg.chatId, { type: "text", text: result.answer });
    log.info({ chatId: msg.chatId }, "reply sent");
  }

  async function flushQueue(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (pending.length > 0) {
        const msg = pending.shift()!;
        try {
          await handleTurn(msg);
        } catch (err) {
          log.error({ err, chatId: msg.chatId }, "turn failed");
          try {
            // Transport-only — must not enter raw_log / working context, or the
            // next turn can parrot the apology as a "successful" answer.
            await channel.send(msg.chatId, {
              type: "text",
              text: "Sorry — I hit an error generating a reply. Try again in a moment.",
              recordInRawLog: false,
            });
          } catch (sendErr) {
            log.error({ err: sendErr }, "failed to send error notice");
          }
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
          // Reply to the latest message in the burst; earlier ones are already
          // in raw_log and will be part of working context / the closed episode.
          const latest = batched[batched.length - 1]!;
          log.info(
            { chatId: latest.chatId, burstSize: batched.length },
            "debounce flushed — queuing turn",
          );
          pending.push(latest);
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
