/**
 * Bundled general-purpose token estimator (§8.3).
 * Slight overestimate is the safe failure direction for context budgeting.
 * ~3 characters per token is a common upper-bound heuristic for English/code mixes.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}
