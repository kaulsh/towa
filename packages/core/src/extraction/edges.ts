import type { Kysely } from "kysely";

import { randomUUID } from "node:crypto";

import type { Database } from "../db/types.js";
import type { ExtractedEdge, PreparedEdgeWrite, ResolvedEntity } from "./types.js";

import { VALID_TO_OPEN_SENTINEL } from "../db/constants.js";

/**
 * Prepare bitemporal edge writes (§2.3):
 * - Open edges always use VALID_TO_OPEN_SENTINEL (never NULL).
 * - Close old edges only on clear contradiction for single-valued relations.
 * - Many-valued relations are additive by default.
 *
 * Reads happen here; the actual INSERT/UPDATE is deferred to the short
 * commit transaction (no LLM in that txn).
 */
export async function prepareEdgeWrites(
  db: Kysely<Database>,
  edges: ExtractedEdge[],
  resolved: ResolvedEntity[],
  episodeId: number,
  episodeClosedAt: number,
  ingestedAt: number,
): Promise<PreparedEdgeWrite[]> {
  const mentionToNode = new Map(resolved.map((r) => [r.mentionId, r.nodeId] as const));
  const prepared: PreparedEdgeWrite[] = [];

  for (const edge of edges) {
    const subjectId = mentionToNode.get(edge.subject_mention_id);
    if (!subjectId) {
      continue;
    }

    let objectId: string | null = null;
    let objectLiteral: string | null = edge.object_literal;
    if (edge.object_mention_id) {
      objectId = mentionToNode.get(edge.object_mention_id) ?? null;
      if (!objectId) {
        continue;
      }
      objectLiteral = null;
    }

    const validFrom = edge.valid_from ?? episodeClosedAt;
    const closeEdgeIds: string[] = [];
    let closeValidTo = validFrom;

    if (edge.cardinality === "single" && edge.contradicts_existing) {
      const openEdges = await findOpenEdges(db, subjectId, edge.relation_label, ingestedAt);
      for (const existing of openEdges) {
        // Clear contradiction: different object (node or literal).
        const sameObject =
          (objectId !== null && existing.object_id === objectId) ||
          (objectId === null &&
            objectLiteral !== null &&
            existing.object_literal === objectLiteral);
        if (!sameObject) {
          closeEdgeIds.push(existing.id);
          // Close at the moment the new fact becomes true.
          closeValidTo = validFrom;
        }
      }
    }

    prepared.push({
      id: randomUUID(),
      subjectId,
      relationLabel: edge.relation_label,
      objectId,
      objectLiteral,
      validFrom,
      validTo: VALID_TO_OPEN_SENTINEL,
      ingestedAt,
      provenance: [episodeId],
      closeEdgeIds,
      closeValidTo,
    });
  }

  return prepared;
}

async function findOpenEdges(
  db: Kysely<Database>,
  subjectId: string,
  relationLabel: string,
  now: number,
): Promise<
  Array<{
    id: string;
    object_id: string | null;
    object_literal: string | null;
  }>
> {
  return db
    .selectFrom("kg_edges")
    .select(["id", "object_id", "object_literal"])
    .where("subject_id", "=", subjectId)
    .where("relation_label", "=", relationLabel)
    .where("valid_from", "<=", now)
    .where("valid_to", ">", now)
    .execute();
}
