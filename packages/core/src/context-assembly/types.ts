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

/** Tighten packing when last prompt ≥ this fraction of contextWindow. */
export const DEFAULT_HEADROOM_HIGH_WATERMARK = 0.85;

/** Multiply default top-K by this under headroom pressure. */
export const DEFAULT_HEADROOM_TIGHTEN_FACTOR = 0.5;

export const DEFAULT_MIN_WORKING_TOP_K = 4;
export const DEFAULT_MIN_RETRIEVED_TOP_K = 1;

/**
 * Fixed top-K packing + headroom governor options (§5.2, §6).
 * No pre-call token measurement.
 */
export interface ContextPackingOptions {
  workingTopK?: number;
  retrievedTopK?: number;
  headroomHighWatermark?: number;
  headroomTightenFactor?: number;
  minWorkingTopK?: number;
  minRetrievedTopK?: number;
}

export interface ResolvedPackingLimits {
  workingTopK: number;
  retrievedTopK: number;
  /** True when last-turn usage triggered tightening. */
  tightened: boolean;
  /** Last prompt tokens used for the decision, if any. */
  lastPromptTokens?: number;
  /** promptTokens / contextWindow when lastPromptTokens was set. */
  headroomRatio?: number;
}
