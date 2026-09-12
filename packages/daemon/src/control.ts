/**
 * Localhost control plane rendezvous (§13).
 *
 * Fixed host; fixed default port. Override the port via YAML `control.port`
 * (daemon), `TOWA_CONTROL_PORT`, or CLI `--port` — no runtime-state file.
 */

/** Always loopback — not configurable. */
export const CONTROL_HOST = "127.0.0.1";

/**
 * Default control HTTP port. Chosen to sit outside common app/dev ports
 * (3000/5000/8000/8080, Postgres 5432, Redis 6379, Ollama 11434, …).
 */
export const DEFAULT_CONTROL_PORT = 18741;

export function resolveControlPort(options: {
  /** From `towa … --port`. */
  cliPort?: number;
  /** From YAML `control.port` when the daemon loads config. */
  yamlPort?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  if (options.cliPort != null) return options.cliPort;

  const raw = (options.env ?? process.env).TOWA_CONTROL_PORT?.trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`TOWA_CONTROL_PORT must be a positive integer (got ${JSON.stringify(raw)})`);
    }
    return n;
  }

  if (options.yamlPort != null) return options.yamlPort;
  return DEFAULT_CONTROL_PORT;
}

export function daemonNotRunningMessage(port: number): string {
  return [
    `Towa daemon is not running (could not reach http://${CONTROL_HOST}:${port}).`,
    "Start it with: towa run --config-file <path>",
    "If you changed the control port, pass --port <n> or set TOWA_CONTROL_PORT.",
  ].join("\n");
}
