import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";

import type { ToolDefinition } from "../ai/types.js";
import { getLogger } from "../logging.js";

import type { ToolExecuteResult, ToolTurnContext } from "./types.js";

const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const DEFAULT_WRITE_MAX_BYTES = 20 * 1024 * 1024;

export interface FsToolOptions {
  sandboxRoot: string;
  /** Always-allowed absolute path prefixes. */
  allowlist: readonly string[];
  readMaxBytes?: number;
  writeMaxBytes?: number;
}

function normalizeExistingPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path may not exist yet (writes). Resolve parent if possible.
    const parent = dirname(p);
    try {
      return resolve(realpathSync(parent), p.slice(parent.length + 1) || ".");
    } catch {
      return resolve(p);
    }
  }
}

function isUnderRoot(candidate: string, root: string): boolean {
  const c = candidate.endsWith(sep) ? candidate : candidate + sep;
  const r = root.endsWith(sep) ? root : root + sep;
  return candidate === root || c.startsWith(r);
}

/**
 * Path is allowed if under sandbox, under an allowlist prefix, or the path
 * argument / resolved path appears as a substring of the user message (§5.4).
 */
export function isPathAllowed(
  pathArg: string,
  resolved: string,
  opts: FsToolOptions,
  userMessage: string,
): boolean {
  const sandbox = normalizeExistingPath(opts.sandboxRoot);
  if (isUnderRoot(resolved, sandbox)) return true;

  for (const prefix of opts.allowlist) {
    const root = normalizeExistingPath(prefix);
    if (isUnderRoot(resolved, root)) return true;
  }

  // Per-turn grant: exact path arg or resolved path must appear in the message.
  if (userMessage.includes(pathArg) || userMessage.includes(resolved)) {
    return true;
  }
  return false;
}

function resolveUserPath(pathArg: string, sandboxRoot: string): string {
  if (isAbsolute(pathArg)) {
    return normalizeExistingPath(pathArg);
  }
  return normalizeExistingPath(resolve(sandboxRoot, pathArg));
}

function deny(message: string): ToolExecuteResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

export const FsListParams = z.object({
  path: z
    .string()
    .min(1)
    .describe("Directory path (absolute or relative to sandbox)"),
});

export const FsReadParams = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path (absolute or relative to sandbox)"),
});

export const FsWriteParams = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Destination file path (absolute or relative to sandbox)"),
    // Required + nullable: OpenAI tool schemas reject bare `.optional()`.
    content: z
      .string()
      .nullable()
      .default(null)
      .describe("UTF-8 text content to write (mutually exclusive with source)"),
    source: z
      .string()
      .nullable()
      .default(null)
      .describe(
        'Turn media ref such as "media:0" to copy inbound attachment bytes',
      ),
  })
  .refine((v) => (v.content != null) !== (v.source != null), {
    message: "Provide exactly one of content or source",
  });

export function createFsTools(opts: FsToolOptions): {
  definitions: ToolDefinition[];
  executors: Map<string, (args: unknown, ctx: ToolTurnContext) => Promise<ToolExecuteResult>>;
} {
  const log = getLogger("tools.fs");
  mkdirSync(opts.sandboxRoot, { recursive: true });
  const readMax = opts.readMaxBytes ?? DEFAULT_READ_MAX_BYTES;
  const writeMax = opts.writeMaxBytes ?? DEFAULT_WRITE_MAX_BYTES;

  const executors = new Map<
    string,
    (args: unknown, ctx: ToolTurnContext) => Promise<ToolExecuteResult>
  >();

  executors.set("fs_list", async (raw, ctx) => {
    const parsed = FsListParams.safeParse(raw);
    if (!parsed.success) {
      return deny(`Invalid fs_list args: ${parsed.error.message}`);
    }
    const resolved = resolveUserPath(parsed.data.path, opts.sandboxRoot);
    if (!isPathAllowed(parsed.data.path, resolved, opts, ctx.userMessage)) {
      return deny(
        `Path not allowed: ${parsed.data.path}. Use the sandbox, an allowlisted prefix, or include the path in your message.`,
      );
    }
    try {
      accessSync(resolved, constants.R_OK);
      const entries = readdirSync(resolved, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
      }));
      return { content: JSON.stringify({ path: resolved, entries }) };
    } catch (err) {
      return deny(err instanceof Error ? err.message : String(err));
    }
  });

  executors.set("fs_read", async (raw, ctx) => {
    const parsed = FsReadParams.safeParse(raw);
    if (!parsed.success) {
      return deny(`Invalid fs_read args: ${parsed.error.message}`);
    }
    const resolved = resolveUserPath(parsed.data.path, opts.sandboxRoot);
    if (!isPathAllowed(parsed.data.path, resolved, opts, ctx.userMessage)) {
      return deny(
        `Path not allowed: ${parsed.data.path}. Use the sandbox, an allowlisted prefix, or include the path in your message.`,
      );
    }
    try {
      const st = statSync(resolved);
      if (!st.isFile()) {
        return deny(`Not a file: ${resolved}`);
      }
      if (st.size > readMax) {
        return deny(`File too large (${st.size} bytes; max ${readMax})`);
      }
      const text = readFileSync(resolved, "utf8");
      return { content: JSON.stringify({ path: resolved, content: text }) };
    } catch (err) {
      return deny(err instanceof Error ? err.message : String(err));
    }
  });

  executors.set("fs_write", async (raw, ctx) => {
    const parsed = FsWriteParams.safeParse(raw);
    if (!parsed.success) {
      return deny(`Invalid fs_write args: ${parsed.error.message}`);
    }
    const resolved = resolveUserPath(parsed.data.path, opts.sandboxRoot);
    if (!isPathAllowed(parsed.data.path, resolved, opts, ctx.userMessage)) {
      return deny(
        `Path not allowed: ${parsed.data.path}. Use the sandbox, an allowlisted prefix, or include the path in your message.`,
      );
    }

    let bytes: Buffer;
    if (parsed.data.source != null) {
      const ref = ctx.mediaRefs.find((m) => m.ref === parsed.data.source);
      if (!ref) {
        return deny(
          `Unknown media source "${parsed.data.source}". Available: ${
            ctx.mediaRefs.map((m) => m.ref).join(", ") || "(none)"
          }`,
        );
      }
      bytes = ref.data;
    } else {
      bytes = Buffer.from(parsed.data.content ?? "", "utf8");
    }

    if (bytes.length > writeMax) {
      return deny(`Write too large (${bytes.length} bytes; max ${writeMax})`);
    }

    try {
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, bytes);
      log.info(
        { path: resolved, bytes: bytes.length, source: parsed.data.source },
        "fs_write ok",
      );
      return {
        content: JSON.stringify({
          path: resolved,
          bytesWritten: bytes.length,
          source: parsed.data.source ?? null,
        }),
      };
    } catch (err) {
      return deny(err instanceof Error ? err.message : String(err));
    }
  });

  const definitions: ToolDefinition[] = [
    {
      name: "fs_list",
      description:
        "List files and directories at a path under the sandbox, allowlist, or a path granted in the user message.",
      parameters: FsListParams,
    },
    {
      name: "fs_read",
      description:
        "Read a UTF-8 text file under the sandbox, allowlist, or a path granted in the user message.",
      parameters: FsReadParams,
    },
    {
      name: "fs_write",
      description:
        'Write a file under the sandbox, allowlist, or a path granted in the user message. Pass either UTF-8 "content" or source "media:N" for turn media.',
      parameters: FsWriteParams,
    },
  ];

  return { definitions, executors };
}
