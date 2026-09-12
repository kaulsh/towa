/**
 * Retrieval pipeline types — design doc §5 (DB search / assemble).
 * LLM orchestration types live under `ai/` (query-gen, assess, answer).
 */

/** Standard RRF constant. */
export const RRF_K = 60;

/** Default per-signal result limit before RRF. */
export const DEFAULT_SEARCH_LIMIT = 20;

export type FtsSourceType = "raw_log" | "gist";

/** One hit from a single search signal, ranked 1-based within that list. */
export interface SearchHit {
  /** Episode this hit contributes to (RRF fusion key). */
  episodeId: number;
  /** Optional KG edges associated with a graph/temporal hit. */
  edgeIds?: string[];
  /** 1-based rank within this signal's result list. */
  rank: number;
}

export interface RrfScoredEpisode {
  episodeId: number;
  score: number;
  /** Edge ids observed across signals for this episode. */
  edgeIds: string[];
}

export interface KgFact {
  edgeId: string;
  subjectId: string;
  subjectName: string;
  relationLabel: string;
  objectId: string | null;
  objectName: string | null;
  objectLiteral: string | null;
  validFrom: number;
  validTo: number;
  /** True when valid_from <= now < valid_to. */
  isCurrent: boolean;
}

/** Re-export query-gen shapes so retrieval consumers can import from one place. */
export type { HistoryRequest, QueryGenResult } from "../ai/query-gen.js";
