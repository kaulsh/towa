import type {
  ContextPackingOptions,
  ResolvedPackingLimits,
} from "./types.js";
import {
  DEFAULT_HEADROOM_HIGH_WATERMARK,
  DEFAULT_HEADROOM_TIGHTEN_FACTOR,
  DEFAULT_MIN_RETRIEVED_TOP_K,
  DEFAULT_MIN_WORKING_TOP_K,
  DEFAULT_RETRIEVED_TOP_K,
  DEFAULT_WORKING_TOP_K,
} from "./types.js";

/**
 * Resolve effective top-K from defaults + last-turn usage (§6 headroom governor).
 *
 * If `lastPromptTokens / contextWindow >= highWatermark`, tighten both Ks by
 * `tightenFactor` (floored at mins). Missing usage or cold start → defaults.
 */
export function resolvePackingLimits(
  contextWindow: number,
  lastPromptTokens: number | undefined,
  options: ContextPackingOptions = {},
): ResolvedPackingLimits {
  const workingDefault = options.workingTopK ?? DEFAULT_WORKING_TOP_K;
  const retrievedDefault = options.retrievedTopK ?? DEFAULT_RETRIEVED_TOP_K;
  const highWatermark =
    options.headroomHighWatermark ?? DEFAULT_HEADROOM_HIGH_WATERMARK;
  const tightenFactor =
    options.headroomTightenFactor ?? DEFAULT_HEADROOM_TIGHTEN_FACTOR;
  const minWorking = options.minWorkingTopK ?? DEFAULT_MIN_WORKING_TOP_K;
  const minRetrieved = options.minRetrievedTopK ?? DEFAULT_MIN_RETRIEVED_TOP_K;

  if (
    lastPromptTokens === undefined ||
    lastPromptTokens <= 0 ||
    contextWindow <= 0
  ) {
    return {
      workingTopK: workingDefault,
      retrievedTopK: retrievedDefault,
      tightened: false,
    };
  }

  const headroomRatio = lastPromptTokens / contextWindow;
  if (headroomRatio < highWatermark) {
    return {
      workingTopK: workingDefault,
      retrievedTopK: retrievedDefault,
      tightened: false,
      lastPromptTokens,
      headroomRatio,
    };
  }

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
    lastPromptTokens,
    headroomRatio,
  };
}
