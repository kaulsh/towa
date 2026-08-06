/**
 * Working-context / session / packing types — design doc §6.
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

/** Default idle gap that starts a new session (§6: e.g. >2 hours). */
export const DEFAULT_SESSION_IDLE_THRESHOLD_SEC = 2 * 60 * 60;

/** Default working-context turn top-K (§6). */
export const DEFAULT_WORKING_TOP_K = 24;

/** Default retrieved-episode top-K (§5.2 / §6). */
export const DEFAULT_RETRIEVED_TOP_K = 6;

/**
 * Meaningful rise in answer promptTokens vs the prior sample (§6).
 * `last / previous >=` this → tighten (when not already releasing on drop).
 */
export const DEFAULT_HEADROOM_RISE_RATIO = 1.15;

/**
 * Substantial drop in answer promptTokens vs the prior sample (§6).
 * `last / previous <` this → release to default top-K.
 */
export const DEFAULT_HEADROOM_DROP_RATIO = 0.85;

/** Multiply default top-K by this under headroom pressure. */
export const DEFAULT_HEADROOM_TIGHTEN_FACTOR = 0.5;

export const DEFAULT_MIN_WORKING_TOP_K = 4;
export const DEFAULT_MIN_RETRIEVED_TOP_K = 1;

/**
 * Per-chat headroom state for the usage-relative governor (§6).
 * No absolute context-window size — only consecutive answer usage samples.
 */
export interface PackingHeadroomState {
  /** Most recent answer `usage.promptTokens`. */
  lastPromptTokens: number;
  /** Answer promptTokens from the turn before last, when known. */
  previousPromptTokens?: number;
  /** Whether the last packing decision used tightened top-K. */
  tightened: boolean;
}

/**
 * Fixed top-K packing + usage-relative headroom governor options (§5.2, §6).
 * No pre-call token measurement; no absolute context-window denominator.
 */
export interface ContextPackingOptions {
  workingTopK?: number;
  retrievedTopK?: number;
  headroomRiseRatio?: number;
  headroomDropRatio?: number;
  headroomTightenFactor?: number;
  minWorkingTopK?: number;
  minRetrievedTopK?: number;
}

export interface ResolvedPackingLimits {
  workingTopK: number;
  retrievedTopK: number;
  /** True when usage-relative pressure triggered (or sticky) tightening. */
  tightened: boolean;
  lastPromptTokens?: number;
  previousPromptTokens?: number;
  /** `lastPromptTokens / previousPromptTokens` when both available. */
  usageRelative?: number;
}
