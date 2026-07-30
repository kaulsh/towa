/**
 * Tiny localhost control plane (§13): POST /command + GET /logs.
 * Uses raw node:http — not an application HTTP framework.
 */
import {
  createReadStream,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { getLogger } from "@towa/core";
import { z } from "zod";

export interface ControlStatusSnapshot {
  ok: true;
  uptimeSec: number;
  pid: number;
  chatModelId: string;
  embeddingModelId: string;
  telegramMode: "polling" | "webhook";
  logPath: string;
  drain: {
    pending: number;
    inProgress: number;
  };
}

export interface ControlServerOptions {
  host: string;
  port: number;
  token?: string;
  logPath: string;
  getStatus: () => Promise<ControlStatusSnapshot> | ControlStatusSnapshot;
  onStop: () => void | Promise<void>;
}

export interface ControlServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

const CommandBodySchema = z.object({
  command: z.string().trim().min(1),
  args: z.record(z.unknown()).default({}),
});

type CommandBody = z.infer<typeof CommandBodySchema>;

/** Validate a parsed JSON value as a control-plane command body. */
function validatedCommandBody(
  raw: unknown,
  res: ServerResponse,
): CommandBody | undefined {
  try {
    return CommandBodySchema.parse(raw);
  } catch (err) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "bad_request",
        message:
          err instanceof z.ZodError
            ? err.errors.map((e) => e.message).join("; ") ||
              "invalid command body"
            : "invalid JSON body",
      },
    });
    return undefined;
  }
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok: false,
      error: { code: "unauthorized", message: "missing or invalid token" },
    }),
  );
}

function checkAuth(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return Boolean(match && match[1] === token);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

function parseLinesQuery(url: URL): number {
  const raw = url.searchParams.get("lines");
  if (!raw) return 200;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 200;
  return Math.min(Math.trunc(n), 10_000);
}

function parseFollowQuery(url: URL): boolean {
  const raw = url.searchParams.get("follow");
  if (raw === null) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/** Read the last `lineCount` lines from a UTF-8 file (best-effort). */
function readLastLines(filePath: string, lineCount: number): string {
  if (!existsSync(filePath) || lineCount <= 0) return "";
  const stat = statSync(filePath);
  if (stat.size === 0) return "";

  // Read up to 1 MiB from the end for history.
  const maxBytes = Math.min(stat.size, 1024 * 1024);
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    // Drop possible partial first line when we didn't start at byte 0.
    if (stat.size > maxBytes && lines.length > 0) {
      lines.shift();
    }
    const slice = lines.slice(-lineCount);
    return slice.join("\n") + (slice.length > 0 ? "\n" : "");
  } finally {
    closeSync(fd);
  }
}

async function streamLogs(
  res: ServerResponse,
  logPath: string,
  lineCount: number,
  follow: boolean,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const history = readLastLines(logPath, lineCount);
  if (history) {
    res.write(history);
  }

  if (!follow) {
    res.end();
    return;
  }

  let offset = existsSync(logPath) ? statSync(logPath).size : 0;
  let closed = false;

  const cleanup = (): void => {
    closed = true;
  };
  res.on("close", cleanup);
  reqGone(res, cleanup);

  while (!closed) {
    await sleep(200);
    if (closed) break;
    if (!existsSync(logPath)) {
      offset = 0;
      continue;
    }
    const stat = statSync(logPath);
    // Rotated (file shrank) — reopen from start of new file.
    if (stat.size < offset) {
      offset = 0;
    }
    if (stat.size > offset) {
      const stream = createReadStream(logPath, {
        start: offset,
        end: stat.size - 1,
        encoding: "utf8",
      });
      for await (const chunk of stream) {
        if (closed) break;
        res.write(chunk);
      }
      offset = stat.size;
    }
  }
}

function reqGone(res: ServerResponse, fn: () => void): void {
  res.on("error", fn);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startControlServer(
  options: ControlServerOptions,
): Promise<ControlServerHandle> {
  const log = getLogger("control");
  const startedAt = Date.now();

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!checkAuth(req, options.token)) {
        unauthorized(res);
        return;
      }

      const host = req.headers.host ?? `${options.host}:${options.port}`;
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "GET" && url.pathname === "/logs") {
        await streamLogs(
          res,
          options.logPath,
          parseLinesQuery(url),
          parseFollowQuery(url),
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/command") {
        const body = validatedCommandBody(await readJsonBody(req), res);

        if (!body) return;

        const { command, args: _args } = body;

        if (command === "ping") {
          sendJson(res, 200, {
            ok: true,
            result: { pong: true, uptimeSec: (Date.now() - startedAt) / 1000 },
          });
          return;
        }

        if (command === "status") {
          const status = await options.getStatus();
          sendJson(res, 200, { ok: true, result: status });
          return;
        }

        if (command === "stop") {
          sendJson(res, 200, { ok: true, result: { stopping: true } });
          // Let the response flush before tearing down.
          setImmediate(async () => {
            try {
              await options.onStop();
            } catch (err) {
              log.error({ err }, "stop handler failed");
            } finally {
              res.end();
            }
          });
          return;
        }

        sendJson(res, 404, {
          ok: false,
          error: {
            code: "unknown_command",
            message: `unknown command: ${command}`,
          },
        });
        return;
      }

      sendJson(res, 404, {
        ok: false,
        error: { code: "not_found", message: "use POST /command or GET /logs" },
      });
    } catch (err) {
      log.error({ err }, "control request failed");
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: {
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      } else {
        res.end();
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : options.port;

  log.info({ host: options.host, port }, "control server listening");

  return {
    host: options.host,
    port,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
