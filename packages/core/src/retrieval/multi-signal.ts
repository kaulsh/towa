import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";
import type { LoadedEmbeddingModel } from "../ai/types.js";

import { searchGraph } from "./search-graph.js";
import { searchLexical } from "./search-lexical.js";
import { searchSemantic } from "./search-semantic.js";
import { mergeRrf } from "./rrf.js";
import type { QueryGenResult, RrfScoredEpisode, SearchHit } from "./types.js";
import { DEFAULT_SEARCH_LIMIT } from "./types.js";

export interface MultiSignalSearchOptions {
  nowSec?: number;
  limit?: number;
}

/**
 * Run lexical, semantic, and graph searches in parallel, then RRF-merge (§5.2).
 */
export async function multiSignalSearch(
  db: Kysely<Database>,
  embeddingModel: LoadedEmbeddingModel,
  queryGen: QueryGenResult,
  options: MultiSignalSearchOptions = {},
): Promise<{
  ranked: RrfScoredEpisode[];
  lexical: SearchHit[];
  semantic: SearchHit[];
  graph: SearchHit[];
}> {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);

  const [lexical, semantic, graph] = await Promise.all([
    searchLexical(db, queryGen.searchQueries, limit),
    searchSemantic(db, embeddingModel, queryGen.searchQueries, limit),
    searchGraph(db, queryGen.entityNames, { nowSec, limit }),
  ]);

  const ranked = mergeRrf([lexical, semantic, graph]);
  return { ranked, lexical, semantic, graph };
}
