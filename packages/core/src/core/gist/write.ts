import type { Kysely } from "kysely";

import type { Database } from "../../db/types.js";
import { embeddingToBlob } from "../kg/embeddings.js";
import { indexGistForFts } from "../retrieval/fts-index.js";

export interface WriteEpisodeGistInput {
  episodeId: number;
  gistText: string;
  embedding: number[];
}

/**
 * Persist episode gist + embedding (§2.4).
 * Unconditional at the call-site — every episode gets one.
 * Accepts a Kysely transaction or connection (used inside commitExtraction).
 */
export async function writeEpisodeGist(
  db: Kysely<Database>,
  input: WriteEpisodeGistInput,
): Promise<void> {
  const embeddingBlob =
    input.embedding.length > 0 ? embeddingToBlob(input.embedding) : null;

  await db
    .insertInto("episode_gists")
    .values({
      episode_id: input.episodeId,
      gist_text: input.gistText,
      embedding: embeddingBlob,
    })
    .onConflict((oc) =>
      oc.column("episode_id").doUpdateSet({
        gist_text: input.gistText,
        embedding: embeddingBlob,
      }),
    )
    .execute();

  await indexGistForFts(db, input.episodeId, input.gistText);
}
