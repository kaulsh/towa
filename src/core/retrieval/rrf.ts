import { RRF_K, type RrfScoredEpisode, type SearchHit } from "./types.js";

/**
 * Reciprocal Rank Fusion (§5.2 step 3).
 *
 * score(episode) = Σ 1/(k + rank) across ranked lists.
 * Pure arithmetic — no score calibration between BM25 and cosine.
 */
export function mergeRrf(
  lists: readonly (readonly SearchHit[])[],
  k: number = RRF_K,
): RrfScoredEpisode[] {
  const scores = new Map<number, { score: number; edgeIds: Set<string> }>();

  for (const list of lists) {
    for (const hit of list) {
      const contrib = 1 / (k + hit.rank);
      let entry = scores.get(hit.episodeId);
      if (!entry) {
        entry = { score: 0, edgeIds: new Set() };
        scores.set(hit.episodeId, entry);
      }
      entry.score += contrib;
      for (const edgeId of hit.edgeIds ?? []) {
        entry.edgeIds.add(edgeId);
      }
    }
  }

  return [...scores.entries()]
    .map(([episodeId, { score, edgeIds }]) => ({
      episodeId,
      score,
      edgeIds: [...edgeIds],
    }))
    .sort((a, b) => b.score - a.score);
}
