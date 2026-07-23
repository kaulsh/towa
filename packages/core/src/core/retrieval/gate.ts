import { z } from "zod";

import type { ChatMessage, LoadedChatModel } from "../../models/types.js";
import type { WorkingContextTurn } from "../context-assembly/types.js";

import { generateStructured } from "./structured.js";
import type { GateResult } from "./types.js";

/**
 * Generation call structured output — sufficiency declared here, not by a
 * separate judge LLM (§5.2 step 5 / CLAUDE.md anti-pattern).
 */
const GateOutputSchema = z.union([
  z.object({
    // Required + nullable: OpenAI structured-outputs reject bare `.optional()`.
    insufficient: z.literal(false).nullable().default(null),
    answer: z.string().min(1),
  }),
  z.object({
    insufficient: z.literal(true),
    follow_up_queries: z.array(z.string()).min(1),
  }),
]);

const AnswerOnlySchema = z.object({
  answer: z.string().min(1),
});

/**
 * Run the generation call that doubles as the sufficiency gate.
 * Returns either an answer or follow-up queries for another retrieval round.
 *
 * When `forceAnswer` is set (hard-cap path), the model must produce an answer
 * with the context on hand — no further retrieval loop.
 */
export async function generateWithGate(
  chatModel: LoadedChatModel,
  input: {
    systemPrompt: string;
    workingContext: readonly WorkingContextTurn[];
    retrievedBlocks: string;
    message: string;
    /** Last round: answer with whatever context exists; no insufficient. */
    forceAnswer?: boolean;
  },
): Promise<GateResult> {
  const workingBlock =
    input.workingContext.length === 0
      ? "(empty)"
      : input.workingContext
          .map((t) => `${t.role}: ${t.content}`)
          .join("\n");

  const user = `## Working context
${workingBlock}

${input.retrievedBlocks || "## Retrieved memory\n(none)"}

## Current message
${input.message}`;

  if (input.forceAnswer) {
    const system = `${input.systemPrompt}

You have a working-context buffer (recent turns) and retrieved memory below.
You must answer the user now — no further memory search is available.
Greetings, chitchat, and questions answerable without long-term memory should get a normal reply.
If a factual memory question cannot be grounded, say you don't recall that yet — do not invent memories.
Return JSON: { "answer": "..." }.`;

    const raw = await generateStructured(
      chatModel,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      AnswerOnlySchema,
      {
        schemaDescription: 'Return JSON {"answer":"..."}.',
      },
    );
    return { insufficient: false, answer: raw.answer };
  }

  const system = `${input.systemPrompt}

You have a working-context buffer (recent turns) and retrieved memory below.
Answer the user using that context.

Mark insufficient=true ONLY when the user needs a specific fact from long-term memory that is missing from the context below, and a different memory search might find it.

When insufficient=true, follow_up_queries must be MEMORY SEARCH queries (phrases to look up in past episodes / the knowledge graph) — never questions directed at the user, never clarifiers like "what would you like help with?".

Do NOT mark insufficient for:
- greetings, small talk, thanks, or other chitchat — just answer
- questions answerable from working context alone
- questions that need no personal memory (general knowledge / conversational replies)
- wanting more detail from the user (answer what you can, or ask in the answer text instead)

Never invent memories that are not supported by the context.
Otherwise return { "answer": "..." } (you may include "insufficient": false).`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const raw = await generateStructured(chatModel, messages, GateOutputSchema, {
    schemaDescription:
      'Return JSON either {"answer":"..."} or {"insufficient":true,"follow_up_queries":["memory search phrase",...]} — follow_up_queries are search strings, not questions to the user.',
  });

  if ("insufficient" in raw && raw.insufficient === true) {
    return {
      insufficient: true,
      followUpQueries: raw.follow_up_queries,
    };
  }

  return {
    insufficient: false,
    answer: (raw as { answer: string }).answer,
  };
}
