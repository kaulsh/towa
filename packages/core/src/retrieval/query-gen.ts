import { z } from "zod";

import type { LoadedChatModel } from "../ai/types.js";
import type { WorkingContextTurn } from "../context-assembly/types.js";

import { generateStructured } from "./structured.js";
import type { HistoryRequest, QueryGenResult } from "./types.js";

const QueryGenSchema = z.object({
  search_queries: z.array(z.string()).min(1),
  entity_names: z.array(z.string()).default([]),
  /** Soft hint only — must not be the sole gate to historical retrieval (§5.3). */
  include_history_hint: z.boolean().default(false),
  history_requests: z
    .array(
      z.object({
        entity: z.string(),
        // Required + nullable: OpenAI structured-outputs reject bare `.optional()`.
        relation: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export type QueryGenSchema = z.infer<typeof QueryGenSchema>;

/**
 * Forced query-generation (§5.2 step 1).
 *
 * Mandatory pipeline stage — always runs; the model fills in queries/entities,
 * it cannot decline to search.
 */
export async function generateSearchQueries(
  chatModel: LoadedChatModel,
  message: string,
  recentContext: readonly WorkingContextTurn[],
  /** Extra queries injected on a gate follow-up round. */
  followUpQueries: readonly string[] = [],
): Promise<QueryGenResult> {
  const contextBlock =
    recentContext.length === 0
      ? "(no recent context)"
      : recentContext
          .map((t) => `${t.role}: ${t.content}`)
          .join("\n");

  const followUpBlock =
    followUpQueries.length > 0
      ? `\nAdditional follow-up search directions from a prior insufficient round:\n${followUpQueries.map((q) => `- ${q}`).join("\n")}`
      : "";

  const system = `You are the query-generation stage of a memory-retrieval pipeline.
Given the user's message and recent conversation context, produce search queries and entity names that will help retrieve relevant past episodes and knowledge-graph facts.
This stage always runs — you must produce at least one search query.
If the user is asking an explicitly historical question (e.g. "what did I used to think", "where did I live before"), include a history_requests entry with the entity (and relation if clear).
You may set include_history_hint=true for soft past-tense cues, but prefer history_requests for explicit historical asks.`;

  const user = `Recent context:
${contextBlock}

Current message:
${message}${followUpBlock}

Return JSON with keys: search_queries (string[]), entity_names (string[]), include_history_hint (boolean), history_requests ({entity, relation: string|null}[]).`;

  const raw = await generateStructured(
    chatModel,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    QueryGenSchema,
  );

  const historyRequests: HistoryRequest[] = (raw.history_requests ?? []).map(
    (h) => ({
      entity: h.entity,
      ...(h.relation != null ? { relation: h.relation } : {}),
    }),
  );

  const searchQueries = [
    ...raw.search_queries,
    ...followUpQueries.filter((q) => !raw.search_queries.includes(q)),
  ];

  return {
    searchQueries,
    entityNames: raw.entity_names ?? [],
    includeHistoryHint: raw.include_history_hint ?? false,
    historyRequests,
  };
}
