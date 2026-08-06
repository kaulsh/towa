export { assembleRetrievedContext, formatRetrievedBlocks } from "./assemble.js";
export {
  deleteFtsBySource,
  indexGistForFts,
  indexRawLogForFts,
  escapeFtsQuery,
} from "./fts-index.js";
export { multiSignalSearch } from "./multi-signal.js";
export { runPipeline as runRetrievalAndGenerate } from "../harness/pipeline.js";
export type {
  RunPipelineInput as RunRetrievalAndGenerateInput,
  RunPipelineResult as RunRetrievalAndGenerateResult,
} from "../harness/pipeline.js";
export { mergeRrf } from "./rrf.js";
export { searchGraph } from "./search-graph.js";
export { searchLexical } from "./search-lexical.js";
export {
  searchSemantic,
  parseProvenanceEpisodeIds,
} from "./search-semantic.js";
export {
  getHistory,
  isCurrentlyValid,
  loadCurrentFactsByEdgeIds,
  loadCurrentFactsForEntities,
} from "./temporal.js";
export {
  DEFAULT_SEARCH_LIMIT,
  GATE_MAX_ROUNDS,
  RRF_K,
  type AssembledRetrievedContext,
  type EpisodeTurns,
  type FtsSourceType,
  type HistoryRequest,
  type KgFact,
  type QueryGenResult,
  type RrfScoredEpisode,
  type SearchHit,
} from "./types.js";
