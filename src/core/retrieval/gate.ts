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
    insufficient: z.literal(false).optional(),
    answer: z.string().min(1),
  }),
  z.object({
    insufficient: z.literal(true),
    follow_up_queries: z.array(z.string()).min(1),
  }),
]);

/**
 * Run the generation call that doubles as the sufficiency gate.
 * Returns either an answer or follow-up queries for another retrieval round.
 */
export async function generateWithGate(
  chatModel: LoadedChatModel,
  input: {
    systemPrompt: string;
    workingContext: readonly WorkingContextTurn[];
    retrievedBlocks: string;
    message: string;
  },
): Promise<GateResult> {
  const workingBlock =
    input.workingContext.length === 0
      ? "(empty)"
      : input.workingContext
          .map((t) => `${t.role}: ${t.content}`)
          .join("\n");

  const system = `${input.systemPrompt}

You have a working-context buffer (recent turns) and retrieved memory below.
Answer the user using that context.
If the retrieved memory is insufficient to answer accurately, set insufficient=true and provide follow_up_queries (search directions that would help) instead of guessing.
Otherwise return { "answer": "..." } (you may include "insufficient": false).
Never invent memories that are not supported by the context.`;

  const user = `## Working context
${workingBlock}

${input.retrievedBlocks || "## Retrieved memory\n(none)"}

## Current message
${input.message}`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const raw = await generateStructured(chatModel, messages, GateOutputSchema, {
    schemaDescription:
      'Return JSON either {"answer":"..."} or {"insufficient":true,"follow_up_queries":["..."]}.',
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
