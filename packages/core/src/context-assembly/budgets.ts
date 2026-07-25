import type { LoadedChatModel } from "../ai/types.js";

import type { ComputeTokenBudgetsOptions, TokenBudgets } from "./types.js";

/**
 * Compute per-turn token budgets from the active chat model (§5, §6, §8.3).
 *
 * `reservedForSystemPrompt` is measured via `countTokens(systemPrompt)`.
 * Working / retrieved splits are measured against content with `countTokens`
 * elsewhere — this function only allocates capacity.
 */
export async function computeTokenBudgets(
  chatModel: LoadedChatModel,
  systemPrompt: string,
  options: ComputeTokenBudgetsOptions = {},
): Promise<TokenBudgets> {
  const contextWindow = chatModel.capabilities.contextWindow;
  const reservedForSystemPrompt = await chatModel.countTokens(systemPrompt);
  const reservedForOutput =
    options.reservedForOutput ?? Math.floor(contextWindow * 0.2);
  const workingRatio = options.workingRatio ?? 0.5;

  const totalUsable = Math.max(
    0,
    contextWindow - reservedForSystemPrompt - reservedForOutput,
  );
  const workingContext = Math.floor(totalUsable * workingRatio);
  const retrievedContext = Math.max(0, totalUsable - workingContext);

  return {
    totalUsable,
    workingContext,
    retrievedContext,
    reservedForSystemPrompt,
    reservedForOutput,
  };
}
