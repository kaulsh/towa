import type { Kysely } from "kysely";

import type { Database } from "../../db/types.js";
import type {
  LoadedChatModel,
  LoadedEmbeddingModel,
} from "../../models/types.js";
import {
  buildWorkingContext,
  computeTokenBudgets,
  type ComputeTokenBudgetsOptions,
  type WorkingContextTurn,
} from "../context-assembly/index.js";

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
  /** Current user message text. */
  message: string;
  /**
   * Recent raw turns available for the working-context window (may include
   * the current message; session boundary + token trim are applied here).
   */
  recentTurns: readonly WorkingContextTurn[];
  systemPrompt?: string;
  budgetOptions?: ComputeTokenBudgetsOptions;
  /** Override gate round cap (default GATE_MAX_ROUNDS = 3). */
  maxGateRounds?: number;
  nowSec?: number;
}

export interface RunRetrievalAndGenerateResult {
  answer: string;
  /** How many generation-gate rounds ran (1 = answered on first try). */
  roundsUsed: number;
  lastQueryGen: QueryGenResult;
  lastRetrieved: AssembledRetrievedContext;
  workingContext: WorkingContextTurn[];
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Towa, a personal AI assistant with long-term memory. Prefer retrieved memory and working context over speculation.";

/**
 * Single entry point for the forced retrieval pipeline + generation-gate loop
 * (§5.2, §6). Integration wires this once per turn.
 *
 * Always runs: query-gen → multi-signal search → RRF → assemble → generate/gate.
 * On insufficient, loops with follow_up_queries, hard-capped at K rounds.
 */
export async function runRetrievalAndGenerate(
  input: RunRetrievalAndGenerateInput,
): Promise<RunRetrievalAndGenerateResult> {
  const systemPrompt = input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxRounds = input.maxGateRounds ?? GATE_MAX_ROUNDS;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  const budgets = await computeTokenBudgets(
    input.chatModel,
    systemPrompt,
    input.budgetOptions,
  );

  const workingContext = await buildWorkingContext(
    input.recentTurns,
    input.chatModel,
    {
      budgetTokens: budgets.workingContext,
      nowSec,
    },
  );

  let followUpQueries: string[] = [];
  let lastQueryGen: QueryGenResult | null = null;
  let lastRetrieved: AssembledRetrievedContext | null = null;
  let answer = "";
  let roundsUsed = 0;

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
      chatModel: input.chatModel,
      ranked,
      queryGen,
      retrievedBudgetTokens: budgets.retrievedContext,
      nowSec,
      // Soft hint may widen; explicit history_requests always load history.
      widenHistoryFromHint: queryGen.includeHistoryHint,
    });
    lastRetrieved = retrieved;

    const gate = await generateWithGate(input.chatModel, {
      systemPrompt,
      workingContext,
      retrievedBlocks: retrieved.formattedBlocks,
      message: input.message,
    });

    if (!gate.insufficient) {
      answer = gate.answer;
      break;
    }

    followUpQueries = gate.followUpQueries;
    if (round === maxRounds) {
      // Hard cap reached — best-effort answer rather than leaving the user empty.
      answer =
        "(I could not find enough memory to answer confidently after " +
        `${maxRounds} retrieval rounds. Follow-ups tried: ${followUpQueries.join("; ") || "none"})`;
    }
  }

  return {
    answer,
    roundsUsed,
    lastQueryGen: lastQueryGen!,
    lastRetrieved: lastRetrieved!,
    workingContext,
  };
}
