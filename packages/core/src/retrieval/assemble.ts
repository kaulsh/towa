import type { Kysely } from "kysely";

import type { Database } from "../db/types.js";
import { resolveTurnsForIdRange } from "../raw-log/index.js";

import {
  getHistory,
  loadCurrentFactsByEdgeIds,
  loadCurrentFactsForEntities,
} from "./temporal.js";
import type {
  AssembledRetrievedContext,
  EpisodeTurns,
  HistoryRequest,
  KgFact,
  QueryGenResult,
  RrfScoredEpisode,
} from "./types.js";

export interface AssembleRetrievedContextInput {
  db: Kysely<Database>;
  ranked: readonly RrfScoredEpisode[];
  queryGen: QueryGenResult;
  /** Max RRF-ranked episodes to include (§5.2 fixed top-K). */
  retrievedTopK: number;
  nowSec?: number;
  /**
   * When true (soft hint only), also attach historical facts for entity_names
   * via get_history. Explicit history_requests always trigger get_history.
   */
  widenHistoryFromHint?: boolean;
}

/**
 * Resolve RRF-ranked episodes to verbatim raw turns + KG facts (§5.2 step 4, §5.3).
 *
 * Episodes are added in rank order up to `retrievedTopK` (no token pre-count).
 * Current vs historical facts are presented as distinct labeled blocks.
 */
export async function assembleRetrievedContext(
  input: AssembleRetrievedContextInput,
): Promise<AssembledRetrievedContext> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const episodes: EpisodeTurns[] = [];
  const limit = Math.max(0, input.retrievedTopK);

  for (const scored of input.ranked) {
    if (episodes.length >= limit) {
      break;
    }
    const turns = await loadEpisodeTurns(input.db, scored.episodeId);
    if (turns.turns.length === 0) {
      continue;
    }
    episodes.push(turns);
  }

  const edgeIds = [...new Set(input.ranked.flatMap((r) => r.edgeIds))];

  const currentFromEdges = await loadCurrentFactsByEdgeIds(
    input.db,
    edgeIds,
    nowSec,
  );
  const currentFromEntities = await loadCurrentFactsForEntities(
    input.db,
    input.queryGen.entityNames,
    nowSec,
  );
  const currentFacts = dedupeFacts([
    ...currentFromEdges,
    ...currentFromEntities,
  ]);

  const historyRequests: HistoryRequest[] = [...input.queryGen.historyRequests];
  if (
    input.widenHistoryFromHint &&
    input.queryGen.includeHistoryHint &&
    historyRequests.length === 0
  ) {
    // Soft hint only — widen with entity names; never sole gate (§5.3).
    for (const entity of input.queryGen.entityNames) {
      historyRequests.push({ entity });
    }
  }

  const historicalFacts: KgFact[] = [];
  for (const req of historyRequests) {
    const timeline = await getHistory(input.db, req, nowSec);
    for (const fact of timeline) {
      if (!fact.isCurrent) {
        historicalFacts.push(fact);
      }
    }
  }

  const uniqueHistorical = dedupeFacts(historicalFacts);
  const formattedBlocks = formatRetrievedBlocks(
    episodes,
    currentFacts,
    uniqueHistorical,
  );

  return {
    episodes,
    currentFacts,
    historicalFacts: uniqueHistorical,
    formattedBlocks,
  };
}

async function loadEpisodeTurns(
  db: Kysely<Database>,
  episodeId: number,
): Promise<EpisodeTurns> {
  const episode = await db
    .selectFrom("episodes")
    .select(["id", "start_msg_id", "end_msg_id"])
    .where("id", "=", episodeId)
    .executeTakeFirst();

  if (!episode) {
    return { episodeId, turns: [] };
  }

  const resolved = await resolveTurnsForIdRange(
    db,
    episode.start_msg_id,
    episode.end_msg_id,
  );

  return {
    episodeId,
    turns: resolved.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
    })),
  };
}

function formatEpisodeBlock(ep: EpisodeTurns): string {
  const lines = ep.turns.map((t) => `${t.role}: ${t.content}`);
  return `### Episode ${ep.episodeId}\n${lines.join("\n")}`;
}

function formatFactLine(fact: KgFact): string {
  const object = fact.objectName ?? fact.objectLiteral ?? "(unknown)";
  const window = fact.isCurrent
    ? "current"
    : `valid ${fact.validFrom}→${fact.validTo}`;
  return `- ${fact.subjectName} —[${fact.relationLabel}]→ ${object} (${window})`;
}

/**
 * Present current vs historical facts as distinct labeled blocks (§5.3).
 */
export function formatRetrievedBlocks(
  episodes: readonly EpisodeTurns[],
  currentFacts: readonly KgFact[],
  historicalFacts: readonly KgFact[],
): string {
  const parts: string[] = [];

  if (episodes.length > 0) {
    parts.push(
      "## Retrieved episodes (verbatim)\n" +
        episodes.map(formatEpisodeBlock).join("\n\n"),
    );
  }

  if (currentFacts.length > 0) {
    parts.push(
      "## Current facts\n" + currentFacts.map(formatFactLine).join("\n"),
    );
  }

  if (historicalFacts.length > 0) {
    parts.push(
      "## Historical facts\n" + historicalFacts.map(formatFactLine).join("\n"),
    );
  }

  return parts.join("\n\n");
}

function dedupeFacts(facts: readonly KgFact[]): KgFact[] {
  const seen = new Set<string>();
  const out: KgFact[] = [];
  for (const f of facts) {
    if (seen.has(f.edgeId)) {
      continue;
    }
    seen.add(f.edgeId);
    out.push(f);
  }
  return out;
}
