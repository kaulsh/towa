import type { ZodType } from "zod";

import type {
  ChatMessage,
  GenerateUsage,
  LoadedChatModel,
} from "./types.js";

export interface StructuredGenerateResult<T> {
  value: T;
  usage?: GenerateUsage;
}

/**
 * Structured-output helper with capability fallback (§8.1).
 *
 * When `capabilities.structuredOutput` is true, pass the Zod schema through
 * `generate()`. Otherwise: prompt for JSON, parse, validate; on failure retry
 * once with the parse error included. Forwards provider usage when present.
 */
export async function generateStructured<T>(
  chatModel: LoadedChatModel,
  messages: ChatMessage[],
  schema: ZodType<T>,
  options: { schemaDescription?: string } = {},
): Promise<StructuredGenerateResult<T>> {
  if (chatModel.capabilities.structuredOutput) {
    const out = await chatModel.generate({ messages, schema });
    if (out.structured !== undefined) {
      return {
        value: schema.parse(out.structured),
        ...(out.usage ? { usage: out.usage } : {}),
      };
    }
    return {
      value: parseAndValidate(out.text, schema),
      ...(out.usage ? { usage: out.usage } : {}),
    };
  }

  const schemaHint =
    options.schemaDescription ??
    "Respond with a single JSON object matching the required schema. No markdown fences.";
  const prompted: ChatMessage[] = [
    ...messages,
    {
      role: "user",
      content: `${schemaHint}\nReturn ONLY valid JSON.`,
    },
  ];

  const first = await chatModel.generate({ messages: prompted });
  try {
    return {
      value: parseAndValidate(first.text, schema),
      ...(first.usage ? { usage: first.usage } : {}),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const retry: ChatMessage[] = [
      ...prompted,
      { role: "assistant", content: first.text },
      {
        role: "user",
        content: `Your previous reply was not valid JSON for the schema (${detail}). Reply again with ONLY valid JSON.`,
      },
    ];
    const second = await chatModel.generate({ messages: retry });
    return {
      value: parseAndValidate(second.text, schema),
      ...(second.usage ? { usage: second.usage } : {}),
    };
  }
}

function parseAndValidate<T>(text: string, schema: ZodType<T>): T {
  const json = extractJson(text);
  const parsed: unknown = JSON.parse(json);
  return schema.parse(parsed);
}

/** Strip optional markdown fences and grab the outermost JSON object/array. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const body = fence ? fence[1]!.trim() : trimmed;

  const objStart = body.indexOf("{");
  const arrStart = body.indexOf("[");
  let start = -1;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    start = objStart;
  } else if (arrStart >= 0) {
    start = arrStart;
  }
  if (start < 0) {
    return body;
  }

  const open = body[start]!;
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end > start) {
    return body.slice(start, end + 1);
  }
  return body.slice(start);
}
