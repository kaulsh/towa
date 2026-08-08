/**
 * Working-context / session types — design doc §6.
 * Packing constants live in packing.ts (code defaults, not YAML).
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
