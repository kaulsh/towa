export { assembleRetrievedContext } from "./assemble.js";
export {
  deleteFtsBySource,
  indexGistForFts,
  indexRawLogForFts,
  escapeFtsQuery,
} from "./fts-index.js";
export { multiSignalSearch } from "./search.js";
export {
  DEFAULT_SEARCH_LIMIT,
  RRF_K,
  type FtsSourceType,
  type HistoryRequest,
  type KgFact,
  type QueryGenResult,
  type RrfScoredEpisode,
  type SearchHit,
} from "./types.js";
