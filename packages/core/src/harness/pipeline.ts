import type { Kysely } from "kysely";

import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
  MessagePart,
  ToolDefinition,
} from "../ai/types.js";
import type { Database } from "../db/types.js";
import type { ToolExecutor, TurnMediaRef } from "../tools/types.js";

import { assessMemorySufficiency, generateAnswer, generateSearchQueries } from "../ai/index.js";
import {
  buildWorkingContext,
  excludeTrailingUserTurns,
  resolvePackingLimits,
  type PackingHeadroomState,
  type WorkingContextTurn,
} from "../context-assembly/index.js";
import { getLogger } from "../logging.js";
import { assembleRetrievedContext } from "../retrieval/assemble.js";
import { multiSignalSearch } from "../retrieval/search.js";

/** Hard cap on memory-sufficiency follow-up rounds (§5.2). */
export const GATE_MAX_ROUNDS = 3;

export interface RunPipelineInput {
  db: Kysely<Database>;
  chatModel: LoadedChatModel;
  embeddingModel: LoadedEmbeddingModel;
  /**
   * Current user burst text (already persisted to raw_log before this turn).
   * Passed separately so it is not also packed inside working-context.
   */
  message: string;
  /**
   * Optional image/audio parts for reply-path multimodal generate (§7.3).
   * Attached to assess/answer user messages when non-empty; ignored by query-gen.
   */
  mediaParts?: readonly MessagePart[];
  /**
   * Recent raw turns from the DB (may still include the current unanswered
   * user burst). The pipeline strips that trailing user run before packing
   * the working-context window.
   */
  recentTurns: readonly WorkingContextTurn[];
  systemPrompt?: string;
  /**
   * Per-chat usage-relative headroom state (§6).
   * Cold start / missing → default top-K.
   */
  headroomState?: PackingHeadroomState;
  /** Passed through to working-context session boundary (§6). */
  sessionIdleThresholdSec?: number;
  /** Enabled built-in tools for answer generate (§5.4). */
  tools?: ToolDefinition[];
  toolExecutors?: ReadonlyMap<string, ToolExecutor>;
  turnMediaRefs?: readonly TurnMediaRef[];
}

export interface RunPipelineResult {
  answer: string;
  /** How many memory-assess rounds ran (1 = sufficient on first try). */
  roundsUsed: number;
  /**
   * Prompt tokens from the answer generate of this turn (when reported).
   * Harness stores this for the next turn's headroom governor.
   */
  promptTokens?: number;
  /** Whether this turn's packing used tightened top-K (§6). */
  packingTightened: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Towa, a personal AI assistant. Prefer retrieved memory and working context over speculation.";

/**
 * Forced retrieval pipeline + memory sufficiency loop + answer generate
 * (§5.2, §5.4, §6).
 *
 * Always runs: query-gen → multi-signal search → RRF → assemble → assess.
 * On insufficient, loops with follow_up_queries, hard-capped at K rounds.
 * Then generateAnswer (plain text, optional tools) once.
 */
export async function runPipeline(input: RunPipelineInput): Promise<RunPipelineResult> {
  const systemPrompt = input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const nowSec = Math.floor(Date.now() / 1000);
  const log = getLogger("retrieval");

  const limits = resolvePackingLimits(input.headroomState);
  log.info(
    {
      workingTopK: limits.workingTopK,
      retrievedTopK: limits.retrievedTopK,
      tightened: limits.tightened,
      usageRelative: limits.usageRelative,
      lastPromptTokens: limits.lastPromptTokens,
      previousPromptTokens: limits.previousPromptTokens,
    },
    "context packing limits",
  );

  const priorTurns = excludeTrailingUserTurns(input.recentTurns);
  const workingContext = buildWorkingContext(priorTurns, {
    topK: limits.workingTopK,
    sessionIdleThresholdSec: input.sessionIdleThresholdSec,
  });

  let followUpQueries: string[] = [];
  let lastFormattedBlocks = "";
  let roundsUsed = 0;

  for (let round = 1; round <= GATE_MAX_ROUNDS; round++) {
    roundsUsed = round;

    const queryGen = await generateSearchQueries(
      input.chatModel,
      input.message,
      workingContext,
      followUpQueries,
    );

    const { ranked } = await multiSignalSearch(input.db, input.embeddingModel, queryGen, {
      nowSec,
    });

    const retrieved = await assembleRetrievedContext({
      db: input.db,
      ranked,
      queryGen,
      retrievedTopK: limits.retrievedTopK,
      nowSec,
    });
    lastFormattedBlocks = retrieved.formattedBlocks;

    const forceProceed = round === GATE_MAX_ROUNDS;
    const assess = await assessMemorySufficiency(input.chatModel, {
      systemPrompt,
      workingContext,
      retrievedBlocks: retrieved.formattedBlocks,
      message: input.message,
      mediaParts: input.mediaParts,
      forceProceed,
    });

    if (!assess.insufficient) {
      log.info({ round, forceProceed }, "memory assess: sufficient");
      break;
    }

    log.info(
      {
        round,
        followUpQueries: assess.followUpQueries,
      },
      "memory assess: insufficient — another retrieval round",
    );
    followUpQueries = assess.followUpQueries;
  }

  const answerResult = await generateAnswer(input.chatModel, {
    systemPrompt,
    workingContext,
    retrievedBlocks: lastFormattedBlocks,
    message: input.message,
    mediaParts: input.mediaParts,
    tools: input.tools,
    toolExecutors: input.toolExecutors,
    turnMediaRefs: input.turnMediaRefs,
  });

  log.info(
    {
      roundsUsed,
      answerLen: answerResult.answer.length,
      answerPreview: answerResult.answer.slice(0, 80),
      promptTokens: answerResult.usage?.promptTokens,
    },
    "answer generated",
  );

  return {
    answer: answerResult.answer,
    roundsUsed,
    packingTightened: limits.tightened,
    ...(answerResult.usage?.promptTokens !== undefined
      ? { promptTokens: answerResult.usage.promptTokens }
      : {}),
  };
}
