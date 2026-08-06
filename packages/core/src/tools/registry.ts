import type { ToolDefinition } from "../ai/types.js";

import { createFsTools, type FsToolOptions } from "./fs.js";
import type { BoundTool, ToolExecutor } from "./types.js";
import {
  createWebFetchTool,
  createWebSearchTool,
  type WebFetchProvider,
  type WebSearchProvider,
} from "./web.js";

export interface BuildEnabledToolsInput {
  webSearch?: { provider: WebSearchProvider; apiKey: string };
  webFetch?:
    | { provider: "firecrawl"; apiKey: string }
    | { provider: "fetchapi" };
  fs?: FsToolOptions;
}

/**
 * Assemble the fixed built-in tool set from config providers / secrets (§5.4).
 * No plugin registry — callers pass only what config enabled.
 */
export function buildEnabledTools(input: BuildEnabledToolsInput): {
  definitions: ToolDefinition[];
  executors: Map<string, ToolExecutor>;
  bound: BoundTool[];
} {
  const definitions: ToolDefinition[] = [];
  const executors = new Map<string, ToolExecutor>();
  const bound: BoundTool[] = [];

  if (input.webSearch) {
    const tool = createWebSearchTool(input.webSearch);
    definitions.push(tool.definition);
    executors.set(tool.definition.name, tool.execute);
    bound.push({ definition: tool.definition, execute: tool.execute });
  }

  if (input.webFetch) {
    const tool = createWebFetchTool(input.webFetch);
    definitions.push(tool.definition);
    executors.set(tool.definition.name, tool.execute);
    bound.push({ definition: tool.definition, execute: tool.execute });
  }

  if (input.fs) {
    const tools = createFsTools(input.fs);
    for (const def of tools.definitions) {
      definitions.push(def);
      const exec = tools.executors.get(def.name)!;
      executors.set(def.name, exec);
      bound.push({ definition: def, execute: exec });
    }
  }

  return { definitions, executors, bound };
}

export function buildTurnMediaRefs(
  items: ReadonlyArray<{
    data: Buffer;
    mimeType: string;
    kind: string;
    fileName?: string;
  }>,
): import("./types.js").TurnMediaRef[] {
  return items.map((item, i) => ({
    ref: `media:${i}`,
    kind: item.kind,
    mimeType: item.mimeType,
    ...(item.fileName !== undefined ? { fileName: item.fileName } : {}),
    data: item.data,
  }));
}

export type { WebFetchProvider, WebSearchProvider };
