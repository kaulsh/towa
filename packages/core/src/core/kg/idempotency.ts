import type { Kysely } from "kysely";

import type { Database } from "../../db/types.js";

/**
 * Remove prior extraction artifacts for an episode so a re-run is idempotent
 * (§4.2 crash recovery / Idempotent extraction pattern).
 *
 * - Deletes edges whose provenance JSON array contains this episode id.
 * - Deletes nodes whose sole provenance entry is this episode id.
 * - For nodes that also cite other episodes, strips this episode from provenance.
 * - Deletes the episode gist row if present.
 */
export async function clearEpisodeExtractionArtifacts(
  db: Kysely<Database>,
  episodeId: number,
): Promise<void> {
  const edges = await db
    .selectFrom("kg_edges")
    .select(["id", "provenance"])
    .execute();

  const edgeIdsToDelete: string[] = [];
  for (const edge of edges) {
    const provenance = parseIdArray(edge.provenance);
    if (provenance.includes(episodeId)) {
      edgeIdsToDelete.push(edge.id);
    }
  }
  if (edgeIdsToDelete.length > 0) {
    await db
      .deleteFrom("kg_edges")
      .where("id", "in", edgeIdsToDelete)
      .execute();
  }

  const nodes = await db
    .selectFrom("kg_nodes")
    .select(["id", "provenance"])
    .execute();

  const nodeIdsToDelete: string[] = [];
  for (const node of nodes) {
    const provenance = parseIdArray(node.provenance);
    if (provenance.length === 1 && provenance[0] === episodeId) {
      nodeIdsToDelete.push(node.id);
    } else if (provenance.includes(episodeId)) {
      const next = provenance.filter((id) => id !== episodeId);
      await db
        .updateTable("kg_nodes")
        .set({ provenance: JSON.stringify(next) })
        .where("id", "=", node.id)
        .execute();
    }
  }

  if (nodeIdsToDelete.length > 0) {
    await db
      .deleteFrom("kg_edges")
      .where((eb) =>
        eb.or([
          eb("subject_id", "in", nodeIdsToDelete),
          eb("object_id", "in", nodeIdsToDelete),
        ]),
      )
      .execute();

    await db
      .deleteFrom("kg_nodes")
      .where("id", "in", nodeIdsToDelete)
      .execute();
  }

  await db
    .deleteFrom("episode_gists")
    .where("episode_id", "=", episodeId)
    .execute();
}

function parseIdArray(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is number => typeof x === "number");
    }
  } catch {
    // fall through
  }
  return [];
}
