import type { ToolDefinition } from "../ai/types.js";

import { createFsTools, type FsToolOptions } from "./fs.js";
import type { ToolExecutor, TurnMediaRef } from "./types.js";
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
 * Closed switch over YAML-enabled builtins — not a plugin registry.
 */
export function buildEnabledTools(input: BuildEnabledToolsInput): {
  definitions: ToolDefinition[];
  executors: Map<string, ToolExecutor>;
} {
  const definitions: ToolDefinition[] = [];
  const executors = new Map<string, ToolExecutor>();

  if (input.webSearch) {
    const tool = createWebSearchTool(input.webSearch);
    definitions.push(tool.definition);
    executors.set(tool.definition.name, tool.execute);
  }

  if (input.webFetch) {
    const tool = createWebFetchTool(input.webFetch);
    definitions.push(tool.definition);
    executors.set(tool.definition.name, tool.execute);
  }

  if (input.fs) {
    const tools = createFsTools(input.fs);
    for (const def of tools.definitions) {
      definitions.push(def);
      const exec = tools.executors.get(def.name)!;
      executors.set(def.name, exec);
    }
  }

  return { definitions, executors };
}

export function buildTurnMediaRefs(
  items: ReadonlyArray<{
    data: Buffer;
    mimeType: string;
    kind: string;
    fileName?: string;
  }>,
): TurnMediaRef[] {
  return items.map((item, i) => ({
    ref: `media:${i}`,
    kind: item.kind,
    mimeType: item.mimeType,
    ...(item.fileName !== undefined ? { fileName: item.fileName } : {}),
    data: item.data,
  }));
}

export type { WebFetchProvider, WebSearchProvider };
