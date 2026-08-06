import { z } from "zod";

import type { WorkingContextTurn } from "../context-assembly/types.js";

import { generateStructured } from "./structured.js";
import type { ChatMessage, LoadedChatModel } from "./types.js";

/**
 * Explicit historical request for temporal retrieval (§5.3).
 * Produced by query-gen; consumed by retrieval assemble / get_history.
 */
export interface HistoryRequest {
  entity: string;
  /** Free-form relation label; omit to return all relations for the entity. */
  relation?: string;
}

/** Forced query-gen output — input to multi-signal search (§5.2). */
export interface QueryGenResult {
  searchQueries: string[];
  entityNames: string[];
  /**
   * Soft hint from query-gen that the question may benefit from history.
   * May widen retrieval; never the sole gate to the historical layer (§5.3).
   */
  includeHistoryHint: boolean;
  /**
   * Explicit historical requests — load-bearing path into get_history (§5.3).
   */
  historyRequests: HistoryRequest[];
}

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

/**
 * Forced query-generation (§5.2 step 1).
 *
 * Mandatory pipeline stage — always runs; the model fills in queries/entities,
 * it cannot decline to search.
 *
 * Message shape (§6): system → prior working-context turns as real
 * user/assistant messages → final user turn with the current message.
 * `recentContext` must already exclude the current unanswered burst.
 */
export async function generateSearchQueries(
  chatModel: LoadedChatModel,
  message: string,
  recentContext: readonly WorkingContextTurn[],
  /** Extra queries injected on a memory-assess follow-up round. */
  followUpQueries: readonly string[] = [],
): Promise<QueryGenResult> {
  const followUpBlock =
    followUpQueries.length > 0
      ? `\nAdditional follow-up search directions from a prior insufficient round:\n${followUpQueries.map((q) => `- ${q}`).join("\n")}`
      : "";

  const system = `You are the query-generation stage of a memory-retrieval pipeline.
Prior messages (if any) are the recent live conversation (working-context window).
The latest user message is the current user text to search for.
Produce search queries and entity names that will help retrieve relevant past episodes and knowledge-graph facts.
This stage always runs — you must produce at least one search query.
If the user is asking an explicitly historical question (e.g. "what did I used to think", "where did I live before"), include a history_requests entry with the entity (and relation if clear).
You may set include_history_hint=true for soft past-tense cues, but prefer history_requests for explicit historical asks.`;

  const user = `Current message:
${message}${followUpBlock}

Return JSON with keys: search_queries (string[]), entity_names (string[]), include_history_hint (boolean), history_requests ({entity, relation: string|null}[]).`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...recentContext.map(
      (t): ChatMessage => ({
        role: t.role,
        content: t.content,
      }),
    ),
    { role: "user", content: user },
  ];

  const { value: raw } = await generateStructured(
    chatModel,
    messages,
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
