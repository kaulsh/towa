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
  CONTROL_HOST,
  DEFAULT_CONTROL_PORT,
  daemonNotRunningMessage,
  resolveControlPort,
} from "./control.js";
import { runDaemon } from "./main.js";

function usage(exitCode = 1): never {
  console.error(`Usage:
  towa run --config-file <path>
  towa ping [--port <n>]
  towa status [--port <n>]
  towa stop [--port <n>]
  towa logs [--lines <n>] [--no-follow] [--port <n>]

Control commands talk to the daemon at http://${CONTROL_HOST}:${DEFAULT_CONTROL_PORT}
(override with --port or TOWA_CONTROL_PORT).
`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): {
  command: string;
  configFile?: string;
  port?: number;
  lines?: number;
  follow: boolean;
} {
  const [command, ...rest] = argv;
  if (!command) usage();

  let configFile: string | undefined;
  let port: number | undefined;
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
    if (arg === "--port" || arg === "-p") {
      const next = rest[++i];
      if (!next || !Number.isFinite(Number(next)) || Number(next) <= 0) {
        console.error("Missing positive integer value for --port");
        usage();
      }
      port = Math.trunc(Number(next));
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

  return { command, configFile, port, lines, follow };
}

function authHeaders(): Record<string, string> {
  const token = process.env.TOWA_CONTROL_TOKEN?.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: unknown }).cause;
  const candidates = [err, cause].filter(Boolean) as Error[];
  for (const e of candidates) {
    const code = (e as NodeJS.ErrnoException).code;
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH"
    ) {
      return true;
    }
    if (/fetch failed|ECONNREFUSED|network/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

async function withDaemonReachable<T>(port: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isConnectionFailure(err)) {
      throw new Error(daemonNotRunningMessage(port), { cause: err });
    }
    throw err;
  }
}

async function postCommand(
  port: number,
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return withDaemonReachable(port, async () => {
    const url = `http://${CONTROL_HOST}:${port}/command`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
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
      throw new Error(`POST /command ${command} failed HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return body;
  });
}

async function streamLogs(port: number, lines: number, follow: boolean): Promise<void> {
  await withDaemonReachable(port, async () => {
    const params = new URLSearchParams();
    params.set("lines", String(lines));
    params.set("follow", follow ? "1" : "0");
    const url = `http://${CONTROL_HOST}:${port}/logs?${params}`;

    const res = await fetch(url, {
      headers: authHeaders(),
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
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage(argv.length === 0 ? 1 : 0);
  }

  const { command, configFile, port: cliPort, lines, follow } = parseArgs(argv);
  const port = resolveControlPort({ cliPort });

  if (command === "run") {
    if (!configFile) {
      console.error("`towa run` requires --config-file <path>");
      usage();
    }
    await runDaemon(resolve(configFile));
    // runDaemon keeps the process alive; if it returns, exit.
    return;
  }

  if (command === "ping") {
    const body = await postCommand(port, "ping");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "status") {
    const body = await postCommand(port, "status");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "stop") {
    const body = await postCommand(port, "stop");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (command === "logs") {
    await streamLogs(port, lines ?? 200, follow);
    return;
  }

  console.error(`Unknown command: ${command}`);
  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
