import type {
  ContextPackingOptions,
  PackingHeadroomState,
  ResolvedPackingLimits,
} from "./types.js";
import {
  DEFAULT_HEADROOM_DROP_RATIO,
  DEFAULT_HEADROOM_RISE_RATIO,
  DEFAULT_HEADROOM_TIGHTEN_FACTOR,
  DEFAULT_MIN_RETRIEVED_TOP_K,
  DEFAULT_MIN_WORKING_TOP_K,
  DEFAULT_RETRIEVED_TOP_K,
  DEFAULT_WORKING_TOP_K,
} from "./types.js";

function defaults(
  workingDefault: number,
  retrievedDefault: number,
  extras: Partial<ResolvedPackingLimits> = {},
): ResolvedPackingLimits {
  return {
    workingTopK: workingDefault,
    retrievedTopK: retrievedDefault,
    tightened: false,
    ...extras,
  };
}

function tightenedLimits(
  workingDefault: number,
  retrievedDefault: number,
  tightenFactor: number,
  minWorking: number,
  minRetrieved: number,
  extras: Partial<ResolvedPackingLimits> = {},
): ResolvedPackingLimits {
  return {
    workingTopK: Math.max(
      minWorking,
      Math.floor(workingDefault * tightenFactor),
    ),
    retrievedTopK: Math.max(
      minRetrieved,
      Math.floor(retrievedDefault * tightenFactor),
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
  options: ContextPackingOptions = {},
): ResolvedPackingLimits {
  const workingDefault = options.workingTopK ?? DEFAULT_WORKING_TOP_K;
  const retrievedDefault = options.retrievedTopK ?? DEFAULT_RETRIEVED_TOP_K;
  const riseRatio = options.headroomRiseRatio ?? DEFAULT_HEADROOM_RISE_RATIO;
  const dropRatio = options.headroomDropRatio ?? DEFAULT_HEADROOM_DROP_RATIO;
  const tightenFactor =
    options.headroomTightenFactor ?? DEFAULT_HEADROOM_TIGHTEN_FACTOR;
  const minWorking = options.minWorkingTopK ?? DEFAULT_MIN_WORKING_TOP_K;
  const minRetrieved = options.minRetrievedTopK ?? DEFAULT_MIN_RETRIEVED_TOP_K;

  if (state === undefined || state.lastPromptTokens <= 0) {
    return defaults(workingDefault, retrievedDefault);
  }

  const { lastPromptTokens, previousPromptTokens, tightened: wasTightened } =
    state;

  if (previousPromptTokens === undefined || previousPromptTokens <= 0) {
    return defaults(workingDefault, retrievedDefault, {
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

  // Substantial drop → release pressure.
  if (usageRelative < dropRatio) {
    return defaults(workingDefault, retrievedDefault, sample);
  }

  // Meaningful rise, or sticky under pressure while not dropping.
  if (wasTightened || usageRelative >= riseRatio) {
    return tightenedLimits(
      workingDefault,
      retrievedDefault,
      tightenFactor,
      minWorking,
      minRetrieved,
      sample,
    );
  }

  return defaults(workingDefault, retrievedDefault, sample);
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
