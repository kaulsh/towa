import type { ChatMessage, LoadedChatModel } from "../ai/types.js";

import { generateStructured } from "../ai/structured.js";
import {
  EpisodeExtractionSchema,
  type EpisodeExtraction,
  type EpisodeTurn,
} from "./types.js";

/**
 * Single LLM pass: within-episode coreference + proposed edges + gist (§4.2, §2.4).
 * KG salience is fact-level: only durable personal facts (§2.3, §4).
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
        "Produce a one-sentence gist (always).",
        "Extract entities and edges only for durable personal facts about the",
        "user (identity, preferences, people/places they care about, plans,",
        "durable attributes) — including prefs mentioned casually.",
        "If the episode is greetings-only, agent meta, or general-knowledge /",
        "encyclopedia Q&A with no personal durable content, return empty",
        "entities and edges (gist still required).",
      ].join("\n"),
    },
  ];

  const { value } = await generateStructured(
    chatModel,
    messages,
    EpisodeExtractionSchema,
  );
  return value;
}

function formatTranscript(turns: EpisodeTurn[]): string {
  return turns
    .map((t) => `[${t.role} msg=${t.rawLogId} t=${t.timestamp}] ${t.content}`)
    .join("\n");
}

const EXTRACTION_SYSTEM_PROMPT = `You extract a temporal knowledge graph and episode gist from a conversation episode.

Salience (fact-level, not episode-level):
- WRITE entities/edges for durable personal facts and preferences about the user — identity, likes/dislikes, people and places they care about, stated plans, lasting attributes — even when phrased casually or inside chitchat (e.g. "lol yeah I hate mornings").
- DO NOT WRITE entities/edges for: greetings-only turns; agent meta ("I don't recall", capability talk, how the bot works); world knowledge / encyclopedia content from either side (bios, game trivia, general Q&A with no personal stake).
- Empty entities and edges is correct when nothing personal is durable. Never invent facts.
- Always produce a gist — one dense sentence usable as a retrieval handle — even when entities/edges are empty. Gist is never gated on importance.

Mechanics:
- Resolve within-episode coreference ("my sister" / "she" / "Anaya") into one entity mention.
- Entity types and relation labels are free-form strings.
- For each edge, set cardinality:
  - "single" for inherently single-valued facts (residence, job, relationship status, age, …)
  - "many" for additive facts (friendships, projects, preferences, …)
- Set contradicts_existing=true only when the new single-valued fact clearly replaces a prior one stated in this episode or obviously supersedes prior knowledge you would expect. Prefer false when unsure.
- object_mention_id XOR object_literal: use a mention id when the object is an entity; use object_literal for scalar values.
- Output must match the JSON schema exactly.`;
