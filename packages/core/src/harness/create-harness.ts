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
  MessagePart,
} from "../ai/types.js";
import type { ComputeTokenBudgetsOptions } from "../context-assembly/types.js";
import { loadRecentWorkingTurns } from "../context-assembly/load-turns.js";
import { captionAndPersistInboundMedia } from "../extraction/media.js";
import { getLogger } from "../logging.js";
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
  /** Working / retrieved budget split options (§5 / §6). */
  budgetOptions?: ComputeTokenBudgetsOptions;
}

export type TurnCompletedHandler = (result: TurnResult) => void | Promise<void>;

export interface Harness {
  /** Clear debounce timers. */
  clear(): Promise<void>;
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

/** Text for query-gen / logs, plus multimodal parts for reply-path generate. */
interface UserTurnContent {
  text: string;
  mediaParts: MessagePart[];
}

function contentTextWithReply(msg: InboundMessage): string {
  let base = msg.content.trim();

  if (msg.replyTo) {
    // Rebuild reply prefix from typed field so generation does not depend on
    // parsing the durable content annotation.
    const withoutAnnotation = base.replace(
      /^\[reply to #\d+(?:: "[^"]*")?\]\s*/,
      "",
    );
    const replyPrefix =
      msg.replyTo.quote !== undefined
        ? `[reply to #${msg.replyTo.messageId}: "${msg.replyTo.quote}"]`
        : `[reply to #${msg.replyTo.messageId}]`;
    base = withoutAnnotation
      ? `${replyPrefix} ${withoutAnnotation}`
      : replyPrefix;
  }

  return base;
}

/**
 * Multimodal image parts for reply-path `generate()` when vision is enabled
 * and bytes are present (§7.3 / §8.1).
 *
 * Voice notes are **not** attached here — sync caption transcribes them to
 * text (`[audio transcript]: …`) and that text is what reaches the model.
 */
function mediaPartsForGeneration(
  msg: InboundMessage,
  chatModel: LoadedChatModel,
): MessagePart[] {
  const media = msg.media;
  if (!media?.data) return [];

  const data = Buffer.from(media.data, "base64");
  if (media.kind === "image" && chatModel.capabilities.vision) {
    return [{ type: "image", data, mimeType: media.mimeType }];
  }
  return [];
}

/**
 * Format a sync media artifact for reply-path generation.
 * Durable raw_log keeps `[audio transcript]:` / `[image description]:` markers;
 * the live prompt should read as user content, not a "please transcribe" job.
 */
function formatArtifactForGeneration(artifact: string): string {
  const audioPrefix = "[audio transcript]:";
  if (artifact.startsWith(audioPrefix)) {
    const spoken = artifact.slice(audioPrefix.length).trim();
    return spoken.length > 0
      ? `(voice note — already transcribed) ${spoken}`
      : "(voice note — empty transcript)";
  }
  const imagePrefix = "[image description]:";
  if (artifact.startsWith(imagePrefix)) {
    const desc = artifact.slice(imagePrefix.length).trim();
    return desc.length > 0
      ? `(image — description) ${desc}`
      : "(image — empty description)";
  }
  return artifact;
}

/**
 * Build user turn text (+ multimodal parts) for the reply path.
 * Query-gen / logging use `text`; gate generate uses `text` plus `mediaParts`.
 * When `mediaArtifacts` is set (sync caption), fold those into text.
 * Missing bytes or lacking capability → explicit text notes (no silent drop).
 */
function buildUserTurnContent(
  messages: readonly InboundMessage[],
  chatModel: LoadedChatModel,
  mediaArtifacts?: ReadonlyMap<string, string>,
): UserTurnContent {
  const textChunks: string[] = [];
  const mediaParts: MessagePart[] = [];

  for (const msg of messages) {
    const base = contentTextWithReply(msg);
    const parts = mediaPartsForGeneration(msg, chatModel);
    mediaParts.push(...parts);
    const artifact = mediaArtifacts?.get(msg.messageId);

    if (!msg.media) {
      if (base) textChunks.push(base);
      else textChunks.push("(empty message)");
      continue;
    }

    const { kind, data, fileName } = msg.media;
    const nameNote = fileName ? ` "${fileName}"` : "";

    if (!data) {
      const note = `[user sent ${kind} media${nameNote}; content could not be loaded]`;
      textChunks.push(base ? `${base}\n${note}` : note);
      continue;
    }

    if (artifact) {
      const formatted = formatArtifactForGeneration(artifact);
      textChunks.push(base ? `${base}\n${formatted}` : formatted);
      continue;
    }

    if (parts.length > 0) {
      // Bytes go to generate(); keep a usable text stub for query-gen / FTS.
      textChunks.push(
        base ||
          (kind === "image"
            ? "(user sent an image)"
            : kind === "audio"
              ? "(user sent a voice note)"
              : `(user sent ${kind})`),
      );
      continue;
    }

    const note = `[user sent ${kind} media${nameNote}; content not available in this reply path]`;
    textChunks.push(base ? `${base}\n${note}` : note);
  }

  return {
    text: textChunks.filter((t) => t.length > 0).join("\n"),
    mediaParts,
  };
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
    budgetOptions,
  } = deps;
  const log = getLogger("harness");

  const debounceOpts: HarnessDebounceOptions = {
    idleMs: deps.debounce?.idleMs ?? DEFAULT_DEBOUNCE_IDLE_MS,
    maxWaitMs: deps.debounce?.maxWaitMs ?? DEFAULT_DEBOUNCE_MAX_WAIT_MS,
  };

  const debounce = createBurstDebouncer(debounceOpts);

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

    const userTurn = buildUserTurnContent(
      turnMessages,
      chatModel,
      mediaArtifacts,
    );
    log.info(
      {
        chatId,
        burstSize: turnMessages.length,
        contentPreview: userTurn.text.slice(0, 80),
        mediaPartCount: userTurn.mediaParts.length,
      },
      "running forced retrieval pipeline",
    );

    let result: Awaited<ReturnType<typeof runRetrievalAndGenerate>> | undefined;
    for (;;) {
      const recentTurns = await loadRecentWorkingTurns(db);
      const turn = buildUserTurnContent(
        turnMessages,
        chatModel,
        mediaArtifacts,
      );
      result = await runRetrievalAndGenerate({
        db,
        chatModel,
        embeddingModel,
        message: turn.text,
        mediaParts: turn.mediaParts,
        recentTurns,
        systemPrompt,
        budgetOptions,
        sessionIdleThresholdSec,
      });
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
    async clear(): Promise<void> {
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

    onTurnCompleted(handler: TurnCompletedHandler): () => void {
      turnCompletedHandlers.push(handler);
      return () => {
        const idx = turnCompletedHandlers.indexOf(handler);
        if (idx >= 0) turnCompletedHandlers.splice(idx, 1);
      };
    },
  };
}
