/**
 * Working-context / session types — design doc §6.
 */

export type WorkingContextRole = "user" | "assistant";

/** One raw turn eligible for the sliding working-context window. */
export interface WorkingContextTurn {
  /** raw_log.id */
  id: number;
  role: WorkingContextRole;
  content: string;
  /** Unix epoch seconds (message time). */
  timestamp: number;
}

export interface TokenBudgets {
  /** contextWindow − reserved system − reserved output. */
  totalUsable: number;
  /** Portion reserved for the sliding working-context buffer. */
  workingContext: number;
  /** Portion reserved for retrieved memory. */
  retrievedContext: number;
  /** Tokens reserved for the system prompt (via countTokens). */
  reservedForSystemPrompt: number;
  /** Tokens reserved for model output. */
  reservedForOutput: number;
}

export interface ComputeTokenBudgetsOptions {
  /**
   * Tokens reserved for the generation response.
   * Defaults to ~20% of the model's contextWindow (derived from capabilities,
   * not a fixed global constant).
   */
  reservedForOutput?: number;
  /**
   * Fraction of usable budget given to working-context (rest → retrieved).
   * Default 0.5 (even split per §6).
   */
  workingRatio?: number;
}

/** Default idle gap that starts a new session (§6: e.g. >2 hours). */
export const DEFAULT_SESSION_IDLE_THRESHOLD_SEC = 2 * 60 * 60;
