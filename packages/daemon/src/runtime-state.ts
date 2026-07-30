/**
 * Runtime state written by `towa run` so other CLI commands can find the
 * control plane (host/port/token/log path).
 */
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface RuntimeState {
  pid: number;
  host: string;
  port: number;
  token?: string;
  logPath: string;
  configFilePath: string;
  dbPath: string;
  startedAt: string;
}

function uidSuffix(): string {
  try {
    return String(process.getuid?.() ?? "user");
  } catch {
    return "user";
  }
}

/** Well-known path under XDG_RUNTIME_DIR (fallback /tmp). */
export function defaultRuntimeStatePath(): string {
  const base =
    process.env.XDG_RUNTIME_DIR?.trim() || `/tmp/towa-${uidSuffix()}`;
  return join(base, "towa", "runtime.json");
}

export function writeRuntimeState(
  state: RuntimeState,
  path: string = defaultRuntimeStatePath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readRuntimeState(
  path: string = defaultRuntimeStatePath(),
): RuntimeState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
    if (
      typeof raw.host !== "string" ||
      typeof raw.port !== "number" ||
      typeof raw.logPath !== "string"
    ) {
      throw new Error("invalid runtime state shape");
    }
    return raw;
  } catch (err) {
    throw new Error(
      `Cannot read daemon runtime state at ${path}. Is \`towa run\` active?\n${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export function removeRuntimeState(
  path: string = defaultRuntimeStatePath(),
): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
