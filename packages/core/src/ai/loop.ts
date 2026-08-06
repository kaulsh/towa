import { z } from "zod";

import type { WorkingContextTurn } from "../context-assembly/types.js";
import { getLogger } from "../logging.js";
import type { ToolExecutor, TurnMediaRef } from "../tools/types.js";

import { generateStructured } from "./structured.js";
import type {
  ChatMessage,
  GenerateUsage,
  LoadedChatModel,
  MessagePart,
  ToolDefinition,
} from "./types.js";

/** Hard cap on answer-generation tool rounds (§5.4). */
export const TOOL_MAX_ROUNDS = 8;

export interface AssessUsage {
  promptTokens?: number;
  completionTokens?: number;
}

/** Memory sufficiency assess — no user-facing answer (§5.2). */
export interface AssessSufficient {
  insufficient: false;
  usage?: AssessUsage;
}

export interface AssessInsufficient {
  insufficient: true;
  followUpQueries: string[];
  usage?: AssessUsage;
}

export type AssessResult = AssessSufficient | AssessInsufficient;

export interface AnswerUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface AnswerResult {
  answer: string;
  usage?: AnswerUsage;
}

export interface GenerateWithToolsResult {
  text: string;
  usage?: GenerateUsage;
  roundsUsed: number;
}

/**
 * Memory sufficiency assess — structured only, no user answer (§5.2).
 */
const AssessOutputSchema = z.union([
  z.object({
    insufficient: z.literal(false),
  }),
  z.object({
    insufficient: z.literal(true),
    follow_up_queries: z.array(z.string()).min(1),
  }),
]);

function buildUserContent(
  text: string,
  mediaParts: readonly MessagePart[] | undefined,
): string | MessagePart[] {
  if (!mediaParts || mediaParts.length === 0) {
    return text;
  }
  // Media before text — Gemma multimodal guidance.
  return [...mediaParts, { type: "text", text }];
}

function buildPipelineMessages(input: {
  system: string;
  workingContext: readonly WorkingContextTurn[];
  retrievedBlocks: string;
  message: string;
  mediaParts?: readonly MessagePart[];
}): ChatMessage[] {
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
      content: buildUserContent(userText, input.mediaParts),
    },
  ];
}

function mediaGuidanceBlock(input: {
  message: string;
  mediaParts?: readonly MessagePart[];
}): string {
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
That text IS what the user said — treat it as their message content.
Never ask the user to provide or re-send audio. Never mark insufficient to obtain audio.`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  return mediaGuidance.length > 0 ? `\n${mediaGuidance}` : "";
}

function formatMediaInventory(refs: readonly TurnMediaRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map(
    (r) =>
      `- ${r.ref}${r.fileName ? ` (${r.fileName})` : ""} — ${r.kind}, ${r.mimeType}`,
  );
  return `\n## Turn media refs (for fs_write source)\n${lines.join("\n")}\nUse source \"media:N\" with fs_write to persist these bytes to an allowed path.\n`;
}

/**
 * Dedicated memory-sufficiency assess (§5.2). Declares whether retrieved
 * memory is enough for personal-memory questions — does not produce the
 * user-facing reply.
 *
 * When `forceProceed` is set (last retrieval round), skip the LLM and treat
 * memory as sufficient so `generateAnswer` runs with whatever context exists.
 */
export async function assessMemorySufficiency(
  chatModel: LoadedChatModel,
  input: {
    systemPrompt: string;
    workingContext: readonly WorkingContextTurn[];
    retrievedBlocks: string;
    message: string;
    mediaParts?: readonly MessagePart[];
    /** Last retrieval round: skip assess and proceed to answer. */
    forceProceed?: boolean;
  },
): Promise<AssessResult> {
  if (input.forceProceed) {
    return { insufficient: false };
  }

  const guidance = mediaGuidanceBlock(input);
  const system = `${input.systemPrompt}

Prior messages (if any) are the recent live conversation (working-context window).
The latest user message includes retrieved long-term memory and the current user text.

Your ONLY job is to judge whether retrieved memory is sufficient to answer any
*personal long-term memory* aspects of the user's message. Do NOT write the reply.

Mark insufficient=true ONLY when the user needs a specific fact from long-term memory
that is missing from the retrieved memory / conversation, and a different memory
search might find it.

When insufficient=true, follow_up_queries must be MEMORY SEARCH queries (phrases to
look up in past episodes / the knowledge graph) — never questions directed at the
user, never clarifiers, never requests for the user to send audio/files.

Do NOT mark insufficient for:
- greetings, small talk, thanks, or other chitchat
- questions answerable from the prior conversation alone
- questions that need no personal memory (general knowledge / web / tools / conversational replies)
- wanting more detail from the user
- questions answerable from attached images when media is present
- questions about a voice note that already has a transcript in the current message
${guidance}
Return JSON: either {"insufficient":false} or {"insufficient":true,"follow_up_queries":["memory search phrase",...]}.`;

  const messages = buildPipelineMessages({
    system,
    workingContext: input.workingContext,
    retrievedBlocks: input.retrievedBlocks,
    message: input.message,
    mediaParts: input.mediaParts,
  });

  const { value: raw, usage } = await generateStructured(
    chatModel,
    messages,
    AssessOutputSchema,
    {
      schemaDescription:
        'Return JSON either {"insufficient":false} or {"insufficient":true,"follow_up_queries":["memory search phrase",...]} — follow_up_queries are search strings, not questions to the user.',
    },
  );

  if (raw.insufficient === true) {
    return {
      insufficient: true,
      followUpQueries: raw.follow_up_queries,
      ...(usage ? { usage } : {}),
    };
  }

  return {
    insufficient: false,
    ...(usage ? { usage } : {}),
  };
}

export interface GenerateAnswerInput {
  systemPrompt: string;
  workingContext: readonly WorkingContextTurn[];
  retrievedBlocks: string;
  message: string;
  mediaParts?: readonly MessagePart[];
  /** Enabled built-in tools (empty / omit → plain text generate). */
  tools?: ToolDefinition[];
  /** Executors keyed by tool name — required when tools are non-empty. */
  toolExecutors?: ReadonlyMap<string, ToolExecutor>;
  /** Turn-scoped media refs for fs_write source=media:N. */
  turnMediaRefs?: readonly TurnMediaRef[];
  maxToolRounds?: number;
}

/**
 * Bounded assistant generate loop with native tools (§5.4).
 * Call sites that already have assembled messages use this; prefer
 * `generateAnswer` for the normal reply path.
 *
 * Does not combine with structured `schema` on the same generate call.
 */
export async function generateWithTools(input: {
  chatModel: LoadedChatModel;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  executors: ReadonlyMap<string, ToolExecutor>;
  maxRounds: number;
  turnContext: {
    userMessage: string;
    mediaRefs: readonly TurnMediaRef[];
  };
}): Promise<GenerateWithToolsResult> {
  const log = getLogger("ai.loop");
  const messages: ChatMessage[] = [...input.messages];
  let lastUsage: GenerateUsage | undefined;
  let roundsUsed = 0;

  for (let round = 1; round <= input.maxRounds; round++) {
    roundsUsed = round;
    const out = await input.chatModel.generate({
      messages,
      tools: input.tools,
    });
    if (out.usage) {
      lastUsage = out.usage;
    }

    const toolCalls = out.toolCalls ?? [];
    if (toolCalls.length === 0) {
      const text = out.text.trim();
      if (text.length > 0) {
        return {
          text,
          roundsUsed,
          ...(lastUsage ? { usage: lastUsage } : {}),
        };
      }
      log.warn({ round }, "generateWithTools: empty text and no tool calls");
      return {
        text: "I couldn't produce a reply.",
        roundsUsed,
        ...(lastUsage ? { usage: lastUsage } : {}),
      };
    }

    messages.push({
      role: "assistant",
      content: out.text || "",
      toolCalls,
    });

    for (const call of toolCalls) {
      const executor = input.executors.get(call.name);
      let content: string;
      if (!executor) {
        content = JSON.stringify({
          error: `Unknown tool: ${call.name}`,
        });
      } else {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments || "{}") as unknown;
        } catch {
          content = JSON.stringify({
            error: `Invalid JSON arguments for ${call.name}`,
            raw: call.arguments,
          });
          messages.push({
            role: "tool",
            content,
            toolCallId: call.id,
          });
          continue;
        }
        try {
          const result = await executor(args, input.turnContext);
          content = result.content;
          log.info(
            {
              tool: call.name,
              isError: result.isError ?? false,
              resultLen: content.length,
            },
            "tool executed",
          );
        } catch (err) {
          content = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
          log.warn({ tool: call.name, err }, "tool executor threw");
        }
      }
      messages.push({
        role: "tool",
        content,
        toolCallId: call.id,
      });
    }
  }

  log.warn({ maxRounds: input.maxRounds }, "generateWithTools hit max rounds");
  // One last generate without tools to force a user-facing reply.
  const final = await input.chatModel.generate({ messages });
  if (final.usage) {
    lastUsage = final.usage;
  }
  const text =
    final.text.trim() ||
    "I hit the tool-use limit before finishing. Please try a simpler request.";
  return {
    text,
    roundsUsed,
    ...(lastUsage ? { usage: lastUsage } : {}),
  };
}

/**
 * User-facing answer generate (§5.2 / §5.4). Plain text; optional bounded
 * native tool loop when tools + toolCalling are available.
 */
export async function generateAnswer(
  chatModel: LoadedChatModel,
  input: GenerateAnswerInput,
): Promise<AnswerResult> {
  const log = getLogger("ai.loop");
  const guidance = mediaGuidanceBlock(input);
  const mediaInventory = formatMediaInventory(input.turnMediaRefs ?? []);
  const tools = input.tools ?? [];
  const canUseTools =
    tools.length > 0 &&
    chatModel.capabilities.toolCalling &&
    input.toolExecutors !== undefined &&
    input.toolExecutors.size > 0;

  const toolHint = canUseTools
    ? `\nYou may use the provided tools (web search/fetch, filesystem) when helpful. Prefer retrieved memory for personal facts. After tools finish, reply to the user in plain text.`
    : "";

  const system = `${input.systemPrompt}

Prior messages (if any) are the recent live conversation (working-context window).
The latest user message includes retrieved long-term memory and the current user text.
Answer the user using that conversation and retrieved memory.${toolHint}${guidance}${mediaInventory}
Never invent personal memories that are not supported by the conversation or retrieved memory.
Reply in plain text (not JSON).`;

  const messages = buildPipelineMessages({
    system,
    workingContext: input.workingContext,
    retrievedBlocks: input.retrievedBlocks,
    message: input.message,
    mediaParts: input.mediaParts,
  });

  if (!canUseTools) {
    const out = await chatModel.generate({ messages });
    return {
      answer: out.text.trim(),
      ...(out.usage ? { usage: out.usage } : {}),
    };
  }

  const maxRounds = input.maxToolRounds ?? TOOL_MAX_ROUNDS;
  log.info({ toolCount: tools.length, maxRounds }, "answer generate with tools");

  const loop = await generateWithTools({
    chatModel,
    messages,
    tools,
    executors: input.toolExecutors!,
    maxRounds,
    turnContext: {
      userMessage: input.message,
      mediaRefs: input.turnMediaRefs ?? [],
    },
  });

  return {
    answer: loop.text.trim(),
    ...(loop.usage ? { usage: loop.usage } : {}),
  };
}
