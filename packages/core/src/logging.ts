/**
 * Process-wide logging (§13).
 *
 * Daemon calls `configureLogging` once at `towa run`. Everywhere else uses
 * `getLogger(name)` — never bare `pino()`, never thread `logger` through deps.
 *
 * Call `getLogger` at use sites (or inside factories after configure), not at
 * module top-level — an early import-time child would miss the configured
 * multistream destinations.
 */
import { createWriteStream, existsSync, renameSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import pino, { type Logger, multistream, type DestinationStream } from "pino";

export interface ConfigureLoggingOptions {
  /** Absolute or relative path for the primary NDJSON log file. */
  filePath: string;
  /** Rotate when the active file would exceed this size. Default 10 MiB. */
  maxBytes?: number;
  /** Also write to stdout. Default true. */
  stdout?: boolean;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

let root: Logger | null = null;
let configuredFilePath: string | null = null;

/**
 * Size-capped file destination: when writes would push past `maxBytes`,
 * rename `file` → `file.1` (overwrite) and open a fresh primary file.
 */
function createRotatingFileDestination(filePath: string, maxBytes: number): DestinationStream {
  mkdirSync(dirname(filePath), { recursive: true });

  let stream = createWriteStream(filePath, { flags: "a" });
  let size = existsSync(filePath) ? statSync(filePath).size : 0;

  const reopen = (): void => {
    stream.end();
    try {
      renameSync(filePath, `${filePath}.1`);
    } catch {
      // Missing primary on first rotate is fine.
    }
    stream = createWriteStream(filePath, { flags: "a" });
    size = 0;
  };

  return new Writable({
    write(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size > 0 && size + buf.length > maxBytes) {
        reopen();
      }
      size += buf.length;
      stream.write(buf, callback);
    },
    final(callback) {
      stream.end(callback);
    },
  });
}

/**
 * Install the process root logger (stdout + rotating file).
 * Safe to call once per process; subsequent calls replace the root.
 */
export function configureLogging(options: ConfigureLoggingOptions): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const useStdout = options.stdout !== false;
  const streams: { stream: DestinationStream; level?: pino.Level }[] = [];

  if (useStdout) {
    streams.push({ stream: pino.destination(1) });
  }
  streams.push({
    stream: createRotatingFileDestination(options.filePath, maxBytes),
  });

  root = pino({ level: "info" }, multistream(streams));
  configuredFilePath = options.filePath;
  return root;
}

/** Absolute path of the configured log file, if `configureLogging` has run. */
export function getLogFilePath(): string | null {
  return configuredFilePath;
}

/**
 * Child logger bound to `name`. Before `configureLogging`, falls back to
 * stdout-only so early boot / import-time errors still emit something.
 */
export function getLogger(name: string): Logger {
  if (!root) {
    return pino({ name });
  }
  return root.child({ name });
}
