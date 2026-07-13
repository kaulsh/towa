# Towa Implementation Plan — Index

Source: `docs/towa-design.md`. Run order: Phase 0 first (sequential, must merge to `main`), then Tracks A–D in any order relative to each other (fully parallel).

| Order | File | Goal | Depends on |
|---|---|---|---|
| 0 | [`00-foundation.md`](./00-foundation.md) | Project skeleton, SQLite schema/migrations, `LoadedChatModel`/`LoadedEmbeddingModel` and `ChannelAdapter` interface types | — |
| A | [`track-a-model-providers.md`](./track-a-model-providers.md) | Loader factories: `loadOllama`, `loadLlamaCpp`, `loadLocalEmbeddings`, `loadOpenAICompatible`(+embeddings), context-window registry, token counting | Phase 0 |
| B | [`track-b-channel-layer.md`](./track-b-channel-layer.md) | `TelegramAdapter` (Telegraf) implementing `ChannelAdapter` | Phase 0 |
| C | [`track-c-retrieval-context.md`](./track-c-retrieval-context.md) | Forced retrieval pipeline (query-gen → multi-signal search → RRF → gate loop) + working-context/session-boundary assembly | Phase 0 |
| D | [`track-d-write-path-kg.md`](./track-d-write-path-kg.md) | Async extraction drain worker: entity resolution, bitemporal KG writes, episode gists, capability-gated media handling | Phase 0 |

## Scope notes

- Track A is scoped to four loaders only (Ollama, llama.cpp, local embeddings, OpenAI-compatible). `loadAnthropic` and `loadHuggingFaceInference` (design doc §8.2) are explicitly deferred — not part of any track's definition of done here.
- Tracks A–D touch disjoint file trees (see each file's "File-level footprint" section) and depend only on Phase 0's merged interfaces/schema — none of them depend on another track's implementation.
- No track in this plan is assigned to the planning session itself — every track, including Phase 0, is handed to a Cursor subagent.

## Coordination points (need a human decision before/while running)

1. **Phase 0 must be confirmed merged to `main`** before the Track A–D prompt is run — the foundation prompt (below) should be run and completed first, standalone.
2. `GenerateInput`/`GenerateOutput` shapes (referenced by `LoadedChatModel.generate()`) aren't spelled out field-by-field in the design doc — Phase 0 has latitude to define a minimal reasonable shape; Tracks A/C/D should treat whatever Phase 0 lands as authoritative rather than re-deriving it.
3. If any track hits a real design question the doc doesn't answer, it should flag it rather than improvising a resolution silently, per `CLAUDE.md`'s "Workflow for coding agents" section — a few spots in the per-track files above call this out explicitly (e.g. debounce timer ownership in Track B, `EditEvent`/`DeleteEvent` field shapes in Phase 0).
