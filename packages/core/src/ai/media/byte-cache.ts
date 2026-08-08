/**
 * Ephemeral in-process media bytes (§7.3).
 *
 * Telegram fills this when downloading inbound media (and when sending
 * outbound media it already holds). Drain enrichment reads by `fileId`.
 * Never persisted to SQLite — cache miss means no bytes (text note only).
 */

export interface CachedMediaBytes {
  data: Buffer;
  mimeType: string;
}

const cache = new Map<string, CachedMediaBytes>();

/** Store bytes for a platform file id. Overwrites any prior entry. */
export function putMediaBytes(
  fileId: string,
  data: Buffer,
  mimeType: string,
): void {
  cache.set(fileId, { data, mimeType });
}

/** Look up bytes by file id. Null on miss — do not call Telegram. */
export function getMediaBytes(fileId: string): CachedMediaBytes | null {
  return cache.get(fileId) ?? null;
}
