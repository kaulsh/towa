import { z } from "zod";

import type { ChatMessage, LoadedChatModel, MessagePart } from "../ai/types.js";
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

function buildGateUserContent(
  text: string,
  mediaParts: readonly MessagePart[] | undefined,
): string | MessagePart[] {
  if (!mediaParts || mediaParts.length === 0) {
    return text;
  }
  // Media before text — Gemma multimodal guidance.
  return [...mediaParts, { type: "text", text }];
}

function buildGateMessages(input: {
  system: string;
  workingContext: readonly WorkingContextTurn[];
  retrievedBlocks: string;
  message: string;
  mediaParts?: readonly MessagePart[];
}): ChatMessage[] {
  // `workingContext` is prior conversation only (current burst excluded upstream).
  const retrieved =
    input.retrievedBlocks.trim().length > 0
      ? input.retrievedBlocks
      : "## Retrieved memory\n(none)";
  const userText = `${retrieved}\n\n## Current message\n${input.message}`;

  return [
    { role: "system", content: input.system },
    ...input.workingContext.map(
      (t): ChatMessage => ({
        role: t.role,
        content: t.content,
      }),
    ),
    {
      role: "user",
      content: buildGateUserContent(userText, input.mediaParts),
    },
  ];
}

/**
 * Run the generation call that doubles as the sufficiency gate.
 * Returns either an answer or follow-up queries for another retrieval round.
 *
 * Message shape (§6): system instructions → prior working-context turns as
 * real user/assistant messages → final user turn with retrieved memory +
 * current text (+ optional multimodal parts).
 *
 * When `forceAnswer` is set (hard-cap path), the model must produce an answer
 * with the context on hand — no further retrieval loop.
 */
export async function generateWithGate(
  chatModel: LoadedChatModel,
  input: {
    systemPrompt: string;
    /** Prior conversation only — current user burst is `message`. */
    workingContext: readonly WorkingContextTurn[];
    retrievedBlocks: string;
    message: string;
    /** Image/audio parts attached to the final user message for multimodal generate. */
    mediaParts?: readonly MessagePart[];
    /** Last round: answer with whatever context exists; no insufficient. */
    forceAnswer?: boolean;
  },
): Promise<GateResult> {
  const hasMedia = (input.mediaParts?.length ?? 0) > 0;
  const hasVoiceTranscript =
    input.message.includes("(voice note — already transcribed)") ||
    input.message.includes("[audio transcript]:");
  const mediaGuidance = [
    hasMedia
      ? `Attached image media is included with the current user message — you can perceive it.
Do not claim you cannot see the attachment. Do not mark insufficient for questions answerable from the attached image alone.`
      : "",
    hasVoiceTranscript
      ? `Voice notes in the current message are ALREADY transcribed (look for "(voice note — already transcribed)" or "[audio transcript]:").
That text IS what the user said — treat it as their message content and answer it directly.
Never ask the user to provide or re-send audio. Never mark insufficient to obtain audio.`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const mediaGuidanceBlock =
    mediaGuidance.length > 0 ? `\n${mediaGuidance}` : "";

  if (input.forceAnswer) {
    const system = `${input.systemPrompt}

Prior messages (if any) are the recent live conversation (working-context window).
The latest user message includes retrieved long-term memory and the current user text.
You must answer the user now — no further memory search is available.
Greetings, chitchat, and questions answerable without long-term memory should get a normal reply.
If a factual memory question cannot be grounded, say you don't recall that yet — do not invent memories.${mediaGuidanceBlock}
Return JSON: { "answer": "..." }.`;

    const messages = buildGateMessages({
      system,
      workingContext: input.workingContext,
      retrievedBlocks: input.retrievedBlocks,
      message: input.message,
      mediaParts: input.mediaParts,
    });

    const { value: raw, usage } = await generateStructured(
      chatModel,
      messages,
      AnswerOnlySchema,
      {
        schemaDescription: 'Return JSON {"answer":"..."}.',
      },
    );
    return {
      insufficient: false,
      answer: raw.answer,
      ...(usage ? { usage } : {}),
    };
  }

  const system = `${input.systemPrompt}

Prior messages (if any) are the recent live conversation (working-context window).
The latest user message includes retrieved long-term memory and the current user text.
Answer the user using that conversation and retrieved memory.

Mark insufficient=true ONLY when the user needs a specific fact from long-term memory that is missing from the retrieved memory / conversation, and a different memory search might find it.

When insufficient=true, follow_up_queries must be MEMORY SEARCH queries (phrases to look up in past episodes / the knowledge graph) — never questions directed at the user, never clarifiers like "what would you like help with?", never requests for the user to send audio/files.

Do NOT mark insufficient for:
- greetings, small talk, thanks, or other chitchat — just answer
- questions answerable from the prior conversation alone
- questions that need no personal memory (general knowledge / conversational replies)
- wanting more detail from the user (answer what you can, or ask in the answer text instead)
- questions answerable from attached images when media is present
- questions about a voice note that already has a transcript in the current message

Never invent memories that are not supported by the conversation or retrieved memory.${mediaGuidanceBlock}
Otherwise return { "answer": "..." } (you may include "insufficient": false).`;

  const messages = buildGateMessages({
    system,
    workingContext: input.workingContext,
    retrievedBlocks: input.retrievedBlocks,
    message: input.message,
    mediaParts: input.mediaParts,
  });

  const { value: raw, usage } = await generateStructured(
    chatModel,
    messages,
    GateOutputSchema,
    {
      schemaDescription:
        'Return JSON either {"answer":"..."} or {"insufficient":true,"follow_up_queries":["memory search phrase",...]} — follow_up_queries are search strings, not questions to the user.',
    },
  );

  if ("insufficient" in raw && raw.insufficient === true) {
    return {
      insufficient: true,
      followUpQueries: raw.follow_up_queries,
      ...(usage ? { usage } : {}),
    };
  }

  return {
    insufficient: false,
    answer: (raw as { answer: string }).answer,
    ...(usage ? { usage } : {}),
  };
}
