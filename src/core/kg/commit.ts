import type { Kysely } from "kysely";

import type { Database } from "../../db/types.js";
import { markExtractionDone } from "../write-path/queue.js";
import { writeEpisodeGist } from "../gist/write.js";

import { embeddingToBlob } from "./embeddings.js";
import type { PreparedEdgeWrite, PreparedNodeWrite } from "./types.js";

export interface ExtractionCommitInput {
  episodeId: number;
  newNodes: PreparedNodeWrite[];
  edges: PreparedEdgeWrite[];
  gistText: string;
  gistEmbedding: number[];
}

/**
 * One short write transaction: nodes + edge close/open + gist + mark done.
 * Caller must have finished all LLM / embed work before calling this (§4.2).
 */
export async function commitExtraction(
  db: Kysely<Database>,
  input: ExtractionCommitInput,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const node of input.newNodes) {
      await trx
        .insertInto("kg_nodes")
        .values({
          id: node.id,
          type_label: node.typeLabel,
          canonical_name: node.canonicalName,
          aliases: JSON.stringify(node.aliases),
          attributes: JSON.stringify(node.attributes),
          embedding:
            node.embedding.length > 0
              ? embeddingToBlob(node.embedding)
              : null,
          provenance: JSON.stringify(node.provenance),
        })
        .execute();
    }

    for (const edge of input.edges) {
      for (const closeId of edge.closeEdgeIds) {
        await trx
          .updateTable("kg_edges")
          .set({ valid_to: edge.closeValidTo })
          .where("id", "=", closeId)
          .execute();
      }

      await trx
        .insertInto("kg_edges")
        .values({
          id: edge.id,
          subject_id: edge.subjectId,
          relation_label: edge.relationLabel,
          object_id: edge.objectId,
          object_literal: edge.objectLiteral,
          valid_from: edge.validFrom,
          valid_to: edge.validTo,
          ingested_at: edge.ingestedAt,
          provenance: JSON.stringify(edge.provenance),
        })
        .execute();
    }

    await writeEpisodeGist(trx, {
      episodeId: input.episodeId,
      gistText: input.gistText,
      embedding: input.gistEmbedding,
    });

    await markExtractionDone(trx, input.episodeId);
  });
}
