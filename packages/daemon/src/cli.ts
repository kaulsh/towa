#!/usr/bin/env node
/**
 * `towa` CLI — hand-rolled argv (§13).
 *
 *   towa run --config-file PATH   start foreground daemon + control plane
 *   towa ping | status | stop     POST /command clients
 *   towa logs [--lines N] [--no-follow]   GET /logs stream
 */

import { resolve } from "node:path";

import {
  defaultRuntimeStatePath,
  readRuntimeState,
  type RuntimeState,
} from "./runtime-state.js";
import { runDaemon } from "./main.js";

function usage(exitCode = 1): never {
  console.error(`Usage:
  towa run --config-file <path>
  towa ping
  towa status
  towa stop
  towa logs [--lines <n>] [--no-follow]

Control commands talk to the running daemon over localhost HTTP
(runtime state: ${defaultRuntimeStatePath()}).
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): {
  command: string;
  configFile?: string;
  lines?: number;
  follow: boolean;
} {
  const [command, ...rest] = argv;
  if (!command) usage();

  let configFile: string | undefined;
  let lines: number | undefined;
  let follow = true;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--config-file" || arg === "-c") {
      const next = rest[++i];
      if (!next) {
        console.error("Missing value for --config-file");
        usage();
      }
      configFile = next;
      continue;
    }
    if (arg === "--lines") {
      const next = rest[++i];
      if (!next || !Number.isFinite(Number(next))) {
        console.error("Missing numeric value for --lines");
        usage();
      }
      lines = Math.trunc(Number(next));
      continue;
    }
    if (arg === "--no-follow") {
      follow = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  return { command, configFile, lines, follow };
}

function authHeaders(state: RuntimeState): Record<string, string> {
  if (!state.token) return {};
  return { Authorization: `Bearer ${state.token}` };
}

async function postCommand(
  state: RuntimeState,
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const url = `http://${state.host}:${state.port}/command`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(state),
    },
    body: JSON.stringify({ command, args }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // keep text
  }
  if (!res.ok) {
    throw new Error(
      `POST /command ${command} failed HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return body;
}

async function streamLogs(
  state: RuntimeState,
  lines: number,
  follow: boolean,
): Promise<void> {
  const params = new URLSearchParams();
  params.set("lines", String(lines));
  params.set("follow", follow ? "1" : "0");
  const url = `http://${state.host}:${state.port}/logs?${params}`;

  const res = await fetch(url, {
    headers: authHeaders(state),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`GET /logs failed HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value, { stream: true }));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage(argv.length === 0 ? 1 : 0);
  }

  const { command, configFile, lines, follow } = parseArgs(argv);

  if (command === "run") {
    if (!configFile) {
      console.error("`towa run` requires --config-file <path>");
      usage();
    }
    await runDaemon(resolve(configFile));
    // runDaemon keeps the process alive; if it returns, exit.
    return;
  }

  const state = readRuntimeState();

  if (command === "ping") {
    const body = await postCommand(state, "ping");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "status") {
    const body = await postCommand(state, "status");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "stop") {
    const body = await postCommand(state, "stop");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "logs") {
    await streamLogs(state, lines ?? 200, follow);
    return;
  }

  console.error(`Unknown command: ${command}`);
  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
