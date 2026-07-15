import type { ChatMessage, LoadedChatModel } from "../../models/types.js";

import { generateStructured } from "./structured.js";
import {
  EpisodeExtractionSchema,
  type EpisodeExtraction,
  type EpisodeTurn,
} from "./types.js";

/**
 * Single LLM pass: within-episode coreference + proposed edges + gist (§4.2, §2.4).
 * Runs outside any SQLite write transaction.
 */
export async function extractEpisodeKnowledge(
  chatModel: LoadedChatModel,
  turns: EpisodeTurn[],
  episodeClosedAt: number,
): Promise<EpisodeExtraction> {
  const transcript = formatTranscript(turns);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: EXTRACTION_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        `Episode closed_at (unix seconds): ${episodeClosedAt}`,
        "",
        "Transcript:",
        transcript,
        "",
        "Extract entities (coreference already resolved within this episode),",
        "edges, and a one-sentence gist. Always produce a gist even if nothing",
        "seems important.",
      ].join("\n"),
    },
  ];

  return generateStructured(chatModel, messages, EpisodeExtractionSchema);
}

function formatTranscript(turns: EpisodeTurn[]): string {
  return turns
    .map((t) => `[${t.role} msg=${t.id} t=${t.timestamp}] ${t.content}`)
    .join("\n");
}

const EXTRACTION_SYSTEM_PROMPT = `You extract a temporal knowledge graph and episode gist from a conversation episode.

Rules:
- Resolve within-episode coreference ("my sister" / "she" / "Anaya") into one entity mention.
- Entity types and relation labels are free-form strings.
- For each edge, set cardinality:
  - "single" for inherently single-valued facts (residence, job, relationship status, age, …)
  - "many" for additive facts (friendships, projects, preferences, …)
- Set contradicts_existing=true only when the new single-valued fact clearly replaces a prior one stated in this episode or obviously supersedes prior knowledge you would expect. Prefer false when unsure.
- object_mention_id XOR object_literal: use a mention id when the object is an entity; use object_literal for scalar values.
- gist: exactly one dense sentence usable as a retrieval handle. Always required.
- Output must match the JSON schema exactly.`;
