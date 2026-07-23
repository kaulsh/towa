import type { LoadedChatModel } from "../../models/types.js";

import {
  DEFAULT_SESSION_IDLE_THRESHOLD_SEC,
  type WorkingContextTurn,
} from "./types.js";

export interface BuildWorkingContextOptions {
  /** Token budget for the working-context window (from computeTokenBudgets). */
  budgetTokens: number;
  /**
   * Idle gap (seconds) that resets the buffer rather than sliding.
   * Default: 2 hours (§6).
   */
  sessionIdleThresholdSec?: number;
  /** Reference "now" for the newest turn; defaults to last turn's timestamp. */
  nowSec?: number;
}

/**
 * Build a token-budgeted working-context buffer (§6).
 *
 * - Session boundary: an idle gap beyond the threshold drops earlier turns.
 * - Sliding window: keep the most recent turns that fit `budgetTokens`,
 *   measured via the active model's `countTokens()` — never a turn count.
 * - Turns that age out are dropped, not summarized.
 */
export async function buildWorkingContext(
  turns: readonly WorkingContextTurn[],
  chatModel: LoadedChatModel,
  options: BuildWorkingContextOptions,
): Promise<WorkingContextTurn[]> {
  if (turns.length === 0 || options.budgetTokens <= 0) {
    return [];
  }

  const threshold =
    options.sessionIdleThresholdSec ?? DEFAULT_SESSION_IDLE_THRESHOLD_SEC;
  const sorted = [...turns].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  const sessionTurns = applySessionBoundary(sorted, threshold);

  // Walk newest → oldest, accumulate until budget is exhausted.
  const selected: WorkingContextTurn[] = [];
  let used = 0;

  for (let i = sessionTurns.length - 1; i >= 0; i--) {
    const turn = sessionTurns[i]!;
    const cost = await chatModel.countTokens(formatTurnForBudget(turn));
    if (selected.length > 0 && used + cost > options.budgetTokens) {
      break;
    }
    // Always include at least the newest turn even if it alone exceeds budget
    // (caller still needs the live message); subsequent turns are skipped.
    if (selected.length === 0 || used + cost <= options.budgetTokens) {
      selected.push(turn);
      used += cost;
    }
  }

  selected.reverse();
  return selected;
}

/**
 * Drop turns before the most recent idle gap exceeding the threshold.
 * If no gap qualifies, the full sequence is kept (then token-trimmed).
 */
export function applySessionBoundary(
  turnsAscending: readonly WorkingContextTurn[],
  idleThresholdSec: number,
): WorkingContextTurn[] {
  if (turnsAscending.length === 0) {
    return [];
  }

  let sessionStartIdx = 0;
  for (let i = 1; i < turnsAscending.length; i++) {
    const prev = turnsAscending[i - 1]!;
    const curr = turnsAscending[i]!;
    if (curr.timestamp - prev.timestamp > idleThresholdSec) {
      sessionStartIdx = i;
    }
  }

  return turnsAscending.slice(sessionStartIdx);
}

function formatTurnForBudget(turn: WorkingContextTurn): string {
  return `${turn.role}: ${turn.content}`;
}
