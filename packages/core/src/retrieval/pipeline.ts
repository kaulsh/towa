import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";
import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
  MessagePart,
} from "../ai/types.js";
import {
  buildWorkingContext,
  excludeTrailingUserTurns,
  resolvePackingLimits,
  type WorkingContextTurn,
} from "../context-assembly/index.js";
import { getLogger } from "../logging.js";

import { assembleRetrievedContext } from "./assemble.js";
import { generateWithGate } from "./gate.js";
import { multiSignalSearch } from "./multi-signal.js";
import { generateSearchQueries } from "./query-gen.js";
import { GATE_MAX_ROUNDS } from "./types.js";
import type { AssembledRetrievedContext, QueryGenResult } from "./types.js";

export interface RunRetrievalAndGenerateInput {
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
   * Attached to the gate user message when non-empty; ignored by query-gen.
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
   * Previous turn's gate `usage.promptTokens` for this chat (§6 headroom).
   * Cold start / missing → default top-K.
   */
  lastPromptTokens?: number;
  /** Override gate round cap (default GATE_MAX_ROUNDS = 3). */
  maxGateRounds?: number;
  /** Passed through to working-context session boundary (§6). */
  sessionIdleThresholdSec?: number;
  nowSec?: number;
}

export interface RunRetrievalAndGenerateResult {
  answer: string;
  /** How many generation-gate rounds ran (1 = answered on first try). */
  roundsUsed: number;
  lastQueryGen: QueryGenResult;
  lastRetrieved: AssembledRetrievedContext;
  /** Prior conversation only — current user burst is `message`, not here. */
  workingContext: WorkingContextTurn[];
  /**
   * Prompt tokens from the last gate generate of this turn (when reported).
   * Harness stores this for the next turn's headroom governor.
   */
  promptTokens?: number;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Towa, a personal AI assistant with long-term memory. Prefer retrieved memory and working context over speculation.";

/**
 * Single entry point for the forced retrieval pipeline + generation-gate loop
 * (§5.2, §6). Integration wires this once per turn.
 *
 * Always runs: query-gen → multi-signal search → RRF → assemble → generate/gate.
 * On insufficient, loops with follow_up_queries, hard-capped at K rounds.
 *
 * Packing is fixed top-K (+ headroom tighten from `lastPromptTokens`).
 */
export async function runRetrievalAndGenerate(
  input: RunRetrievalAndGenerateInput,
): Promise<RunRetrievalAndGenerateResult> {
  const systemPrompt = input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxRounds = input.maxGateRounds ?? GATE_MAX_ROUNDS;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const log = getLogger("retrieval");

  const limits = resolvePackingLimits(
    input.chatModel.capabilities.contextWindow,
    input.lastPromptTokens,
  );
  log.info(
    {
      workingTopK: limits.workingTopK,
      retrievedTopK: limits.retrievedTopK,
      tightened: limits.tightened,
      headroomRatio: limits.headroomRatio,
      lastPromptTokens: limits.lastPromptTokens,
    },
    "context packing limits",
  );

  // Current burst is already in raw_log / recentTurns; exclude it so the
  // sliding window packs prior conversation only. `input.message` (+ media)
  // is the live user turn for query-gen and the gate.
  const priorTurns = excludeTrailingUserTurns(input.recentTurns);
  const workingContext = buildWorkingContext(priorTurns, {
    topK: limits.workingTopK,
    sessionIdleThresholdSec: input.sessionIdleThresholdSec,
  });

  let followUpQueries: string[] = [];
  let lastQueryGen: QueryGenResult | null = null;
  let lastRetrieved: AssembledRetrievedContext | null = null;
  let answer = "";
  let roundsUsed = 0;
  let promptTokens: number | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    roundsUsed = round;

    const queryGen = await generateSearchQueries(
      input.chatModel,
      input.message,
      workingContext,
      followUpQueries,
    );
    lastQueryGen = queryGen;

    const { ranked } = await multiSignalSearch(
      input.db,
      input.embeddingModel,
      queryGen,
      { nowSec },
    );

    const retrieved = await assembleRetrievedContext({
      db: input.db,
      ranked,
      queryGen,
      retrievedTopK: limits.retrievedTopK,
      nowSec,
      widenHistoryFromHint: queryGen.includeHistoryHint,
    });
    lastRetrieved = retrieved;

    const forceAnswer = round === maxRounds;
    const gate = await generateWithGate(input.chatModel, {
      systemPrompt,
      workingContext,
      retrievedBlocks: retrieved.formattedBlocks,
      message: input.message,
      mediaParts: input.mediaParts,
      forceAnswer,
    });

    if (gate.usage?.promptTokens !== undefined) {
      promptTokens = gate.usage.promptTokens;
    }

    if (!gate.insufficient) {
      log.info(
        {
          round,
          forceAnswer,
          answerLen: gate.answer.length,
          answerPreview: gate.answer.slice(0, 80),
          promptTokens,
        },
        "gate answered",
      );
      answer = gate.answer;
      break;
    }

    log.info(
      {
        round,
        followUpQueries: gate.followUpQueries,
        promptTokens,
      },
      "gate insufficient — another retrieval round",
    );
    followUpQueries = gate.followUpQueries;
  }

  return {
    answer,
    roundsUsed,
    lastQueryGen: lastQueryGen!,
    lastRetrieved: lastRetrieved!,
    workingContext,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
  };
}
