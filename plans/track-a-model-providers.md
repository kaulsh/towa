# Track A — Model Providers

## Goal

Implement the loader-factory functions that produce `LoadedChatModel`/`LoadedEmbeddingModel` instances, plus the context-window registry and per-loader token counting. **Scope for this track: `loadOllama`, `loadLlamaCpp`, `loadLocalEmbeddings`, `loadOpenAICompatible` (+ its embeddings counterpart `loadOpenAICompatibleEmbeddings`) only.** `loadAnthropic` and `loadHuggingFaceInference` are explicitly out of scope — deferred to a later track.

## Dependencies

**Phase 0 only.** This track consumes `src/models/types.ts` (the `LoadedChatModel`/`LoadedEmbeddingModel` interfaces and `GenerateInput`/`GenerateOutput` types) from Phase 0 — read that file as merged, don't re-derive the interface shape from the design doc yourself. Phase 0 must be merged to `main` before you branch.

## Before you start

Read, in full:
- `CLAUDE.md` at the repo root — in particular the "Loader factory pattern for models" code pattern, and the "Model interfaces stay segregated" invariant (never add an optional `embed()` to a chat model or vice versa).
- `docs/towa-design.md` §8 (Model Provider Strategy) in full — §8.1 (interface), §8.2 (loaders table), §8.3 (token counting & context-window registry), §8.4 (model residency/VRAM/thermal reasoning — this explains *why* Ollama is the default chat loader and llama.cpp is not, which should inform any config defaults you set).
- `src/models/types.ts` as it exists on `main` post-Phase-0.

## What to build

### Loaders (`src/models/loaders/`)

Each loader is a `loadX(config)` factory function returning a `LoadedChatModel` or `LoadedEmbeddingModel` — never branch provider-specific logic into call sites (`CLAUDE.md` code pattern). Per design doc §8.2:

| Loader | Role | Notes |
|---|---|---|
| `loadOllama(config)` | chat | **Default for chat + extraction.** Ollama owns model residency (loads on request, unloads on idle ~5min — §8.4). Auto-`pull` if missing. |
| `loadLlamaCpp(config)` | chat | In-process GGUF inference via `node-llama-cpp`. No separate daemon — model stays resident in the daemon's process for its whole lifetime (§8.4 explains this is why it's *not* the default, not a reason to skip implementing it). |
| `loadLocalEmbeddings(config)` | embedding | Local embedding model via `transformers.js`/ONNX, **run on CPU** (§8.4 — small embedding models, 22M–110M params, don't need GPU contention). This fires on every turn via query-gen (§5), so it's the highest-frequency call in the system. |
| `loadOpenAICompatible(config)` | chat | Universal remote/server escape hatch, parameterized by `baseURL` — covers OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio, and Ollama's own OpenAI-compat endpoint in one loader. |
| `loadOpenAICompatibleEmbeddings(config)` | embedding | Same idea, embedding-specific endpoints. |

**Per-role configuration, not one global model** (§8.2 last paragraph): the harness will configure `chatModel`, `extractionModel`, `embeddingModel` (and optional `visionModel`) independently, each pointed at any loader you implement here. You don't need to build that per-role config wiring yourself (that's harness assembly, likely done when tracks are integrated) — just make sure each loader is a clean standalone factory that could be instantiated once per role.

### Context-window registry (`src/models/context-window-registry.ts`)

Per §8.3: a small static table mapping known model ids to context window sizes:

```typescript
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'llama3.1:8b': 128_000,
  'qwen2.5:14b': 128_000,
  'claude-sonnet-5': 200_000,
  // ...
};
```

Every loader's config must accept an optional `contextWindow?: number` override — if a model id isn't in the table, the caller supplies it explicitly rather than the harness guessing or refusing to load. This value populates `capabilities.contextWindow`.

### Token counting

Implement `countTokens()` per loader, with accuracy genuinely varying by provider (§8.3):
- **`loadLlamaCpp`** — exact, via `node-llama-cpp`'s own in-process tokenizer.
- **`loadOllama`** — approximate unless the running model exposes a tokenize endpoint; fall back to a bundled general-purpose estimator otherwise.
- **`loadOpenAICompatible`** — use the provider SDK's own counting utility where one exists (e.g. `tiktoken` for OpenAI-shaped endpoints); otherwise the same bundled estimator.

These counts are for **budgeting, not billing** (§8.3 last paragraph) — a slight overestimate is the safe failure direction, so don't over-invest in per-provider exactness beyond what's listed above.

### Structured-output capability

Per §8.1's "Structured-output fallback": each loader must correctly report `capabilities.structuredOutput`, and where `generate()` is called with a structured-output schema but the underlying model/API doesn't support forced JSON, the loader itself should not silently degrade — that fallback-to-prompt-based-JSON behavior belongs to the *caller* (Track C/D), not the loader. Your job here is just to report the capability accurately so callers can branch on it.

## Interface contract you must produce

Every loader you implement must satisfy the exact `LoadedChatModel`/`LoadedEmbeddingModel` shape from `src/models/types.ts` (Phase 0) — do not add fields to the interface itself; if you find the interface underspecified for a loader's needs, note it rather than silently extending the shared type (that's a coordination point, flag it rather than improvising — per `CLAUDE.md`'s workflow section).

## File-level footprint

```
src/models/loaders/**
src/models/context-window-registry.ts
package.json   (add loader-specific deps only: node-llama-cpp, transformers.js/onnxruntime, an OpenAI-compatible SDK or plain fetch client, ollama client — coordinate additions here since Phase 0 already edited this file; add new deps, don't remove/reorder existing ones)
```

Do not touch `src/models/types.ts` (Phase 0-owned) or anything under `src/core/` or `src/channels/`.

## Definition of done

- `loadOllama`, `loadLlamaCpp`, `loadLocalEmbeddings`, `loadOpenAICompatible`, `loadOpenAICompatibleEmbeddings` are all implemented, typed against `LoadedChatModel`/`LoadedEmbeddingModel`, and exported.
- Each loader's config accepts `contextWindow?: number` and correctly populates `capabilities.contextWindow`, falling back to `KNOWN_CONTEXT_WINDOWS` lookup when not overridden.
- `countTokens()` works on all five loaders per the accuracy tiers above (exact for llama.cpp, best-effort elsewhere).
- No optional `embed()` on any `LoadedChatModel` implementation, and no chat-only fields on any `LoadedEmbeddingModel` implementation (segregated interfaces invariant).
- Typechecks cleanly against Phase 0's `src/models/types.ts` with no modifications to that file.
