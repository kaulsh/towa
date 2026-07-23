import { z, type ZodTypeAny } from "zod";

import type { ChatMessage, LoadedChatModel } from "../../models/types.js";

/**
 * Structured-output helper (§8.1): use native schema when
 * `capabilities.structuredOutput` is true; otherwise prompt-based JSON
 * + Zod parse + one retry.
 */
export async function generateStructured<S extends ZodTypeAny>(
  model: LoadedChatModel,
  messages: ChatMessage[],
  schema: S,
): Promise<z.output<S>> {
  if (model.capabilities.structuredOutput) {
    const out = await model.generate({ messages, schema });
    if (out.structured !== undefined) {
      return schema.parse(out.structured) as z.output<S>;
    }
    // Loader returned text only — fall through to parse path once.
    return parseJsonWithRetry(model, messages, schema, out.text);
  }

  return parseJsonWithRetry(model, messages, schema);
}

async function parseJsonWithRetry<S extends ZodTypeAny>(
  model: LoadedChatModel,
  messages: ChatMessage[],
  schema: S,
  firstText?: string,
): Promise<z.output<S>> {
  const promptMessages: ChatMessage[] = [
    ...messages,
    {
      role: "system",
      content:
        "Respond with a single JSON object only — no markdown fences, no commentary.",
    },
  ];

  const attempt = async (text: string | undefined): Promise<z.output<S>> => {
    if (text === undefined) {
      const out = await model.generate({ messages: promptMessages });
      text = out.text;
    }
    const parsed = JSON.parse(extractJsonObject(text));
    return schema.parse(parsed) as z.output<S>;
  };

  try {
    return await attempt(firstText);
  } catch {
    // One retry with an explicit repair nudge (§8.1).
    const repairMessages: ChatMessage[] = [
      ...promptMessages,
      {
        role: "user",
        content:
          "Your previous reply was not valid JSON matching the required schema. Reply again with only the JSON object.",
      },
    ];
    const out = await model.generate({ messages: repairMessages });
    const parsed = JSON.parse(extractJsonObject(out.text));
    return schema.parse(parsed) as z.output<S>;
  }
}

/** Pull a JSON object out of model text that may include fences or prose. */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    return fence[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

/** Re-export zod for call sites that define schemas alongside this helper. */
export { z };
