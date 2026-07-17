/**
 * Static context-window sizes for known model ids (§8.3).
 * Callers pass `contextWindow` on the loader config when the model is absent.
 */
export const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "llama3.1:8b": 128_000,
  "llama3.1:70b": 128_000,
  "llama3.2:1b": 128_000,
  "llama3.2:3b": 128_000,
  "llama3.3:70b": 128_000,
  "qwen3.6:latest": 256_000,
  "qwen3.6:27b": 256_000,
  "qwen3.6:35b": 256_000,
  "mistral:7b": 32_000,
  "mixtral:8x7b": 32_000,
  "gemma2:9b": 8_192,
  "gemma2:27b": 8_192,
  "gemma4:1latest": 128_000,
  "gemma4:e2b": 128_000,
  "gemma4:e4b": 128_000,
  "gemma4:12b": 256_000,
  "gemma4:26b": 256_000,
  "gemma4:31b": 256_000,
  "phi3:mini": 128_000,
  "phi3:medium": 128_000,
  "claude-sonnet-5": 200_000,
  "claude-opus-4": 200_000,
  "claude-haiku-4": 200_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "o3": 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
};

/**
 * Resolve context window: explicit override → registry lookup → error.
 * Never guess; unknown models require an explicit `contextWindow` in config.
 */
export function resolveContextWindow(
  modelId: string,
  override?: number,
): number {
  if (override !== undefined) {
    return override;
  }
  const known = KNOWN_CONTEXT_WINDOWS[modelId];
  if (known !== undefined) {
    return known;
  }
  // Also try a case-insensitive / bare-name match for OpenAI-style ids
  // that may include org prefixes (e.g. "openai/gpt-4o").
  const bare = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  const bareKnown = KNOWN_CONTEXT_WINDOWS[bare];
  if (bareKnown !== undefined) {
    return bareKnown;
  }
  throw new Error(
    `Unknown context window for model "${modelId}". ` +
      `Pass contextWindow in the loader config, or add it to KNOWN_CONTEXT_WINDOWS.`,
  );
}
