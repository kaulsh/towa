/**
 * Fixed top-K packing + usage-relative headroom governor (§5.2, §6).
 * Code defaults only — not daemon YAML.
 */

export interface PackingHeadroomState {
  /** Most recent answer `usage.promptTokens`. */
  lastPromptTokens: number;
  /** Answer promptTokens from the turn before last, when known. */
  previousPromptTokens?: number;
  /** Whether the last packing decision used tightened top-K. */
  tightened: boolean;
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

const DEFAULT_WORKING_TOP_K = 24;
const DEFAULT_RETRIEVED_TOP_K = 6;
const DEFAULT_HEADROOM_RISE_RATIO = 1.15;
const DEFAULT_HEADROOM_DROP_RATIO = 0.85;
const DEFAULT_HEADROOM_TIGHTEN_FACTOR = 0.5;
const DEFAULT_MIN_WORKING_TOP_K = 4;
const DEFAULT_MIN_RETRIEVED_TOP_K = 1;

function defaults(extras: Partial<ResolvedPackingLimits> = {}): ResolvedPackingLimits {
  return {
    workingTopK: DEFAULT_WORKING_TOP_K,
    retrievedTopK: DEFAULT_RETRIEVED_TOP_K,
    tightened: false,
    ...extras,
  };
}

function tightenedLimits(extras: Partial<ResolvedPackingLimits> = {}): ResolvedPackingLimits {
  return {
    workingTopK: Math.max(
      DEFAULT_MIN_WORKING_TOP_K,
      Math.floor(DEFAULT_WORKING_TOP_K * DEFAULT_HEADROOM_TIGHTEN_FACTOR),
    ),
    retrievedTopK: Math.max(
      DEFAULT_MIN_RETRIEVED_TOP_K,
      Math.floor(DEFAULT_RETRIEVED_TOP_K * DEFAULT_HEADROOM_TIGHTEN_FACTOR),
    ),
    tightened: true,
    ...extras,
  };
}

/**
 * Resolve effective top-K from defaults + usage-relative headroom (§6).
 *
 * No absolute context window. Compare consecutive answer `promptTokens`:
 * - cold start / single sample → defaults
 * - meaningful rise (`>= riseRatio`) → tighten
 * - already tightened and not a substantial drop → stay tightened
 * - substantial drop (`< dropRatio`) → release to defaults
 */
export function resolvePackingLimits(
  state: PackingHeadroomState | undefined,
): ResolvedPackingLimits {
  if (state === undefined || state.lastPromptTokens <= 0) {
    return defaults();
  }

  const { lastPromptTokens, previousPromptTokens, tightened: wasTightened } = state;

  if (previousPromptTokens === undefined || previousPromptTokens <= 0) {
    return defaults({
      lastPromptTokens,
      previousPromptTokens,
    });
  }

  const usageRelative = lastPromptTokens / previousPromptTokens;
  const sample = {
    lastPromptTokens,
    previousPromptTokens,
    usageRelative,
  };

  if (usageRelative < DEFAULT_HEADROOM_DROP_RATIO) {
    return defaults(sample);
  }

  if (wasTightened || usageRelative >= DEFAULT_HEADROOM_RISE_RATIO) {
    return tightenedLimits(sample);
  }

  return defaults(sample);
}

/**
 * Advance per-chat headroom state after an answer generate reports usage.
 * Missing / non-positive usage leaves the prior state unchanged.
 */
export function nextPackingHeadroomState(
  prev: PackingHeadroomState | undefined,
  promptTokens: number | undefined,
  packingTightened: boolean,
): PackingHeadroomState | undefined {
  if (promptTokens === undefined || promptTokens <= 0) {
    return prev;
  }
  return {
    previousPromptTokens: prev?.lastPromptTokens,
    lastPromptTokens: promptTokens,
    tightened: packingTightened,
  };
}
