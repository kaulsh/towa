#!/usr/bin/env node
/**
 * Stub entry for the future `towa` binary.
 * Product CLI commands are intentionally unimplemented; use package scripts
 * to run the daemon (`pnpm --filter @towa/daemon start` / `dev`).
 */

console.log(
  "towa: CLI stub — install works; product commands are not implemented yet. Run the daemon via `@towa/daemon` package scripts.",
);
process.exit(0);
