/**
 * Ephemeral burst debounce (§6) — wait for a short idle gap before firing,
 * capped so a long monologue still gets a reply. Never persisted.
 */

export interface BurstDebouncerOptions {
  /** Idle gap after the last message (or presence nudge) before firing. */
  idleMs: number;
  /** Max wait from the first message in a burst. */
  maxWaitMs: number;
}

export interface BurstDebouncer {
  schedule<T>(
    key: string,
    item: T,
    onFire: (items: T[]) => void,
  ): void;
  /**
   * Reset the idle timer for an in-flight burst without adding an item
   * (e.g. typing / presence widening §6). No-op if no burst is open.
   */
  touch(key: string): void;
  clearAll(): void;
}

export function createBurstDebouncer(
  options: BurstDebouncerOptions,
): BurstDebouncer {
  const { idleMs, maxWaitMs } = options;

  type Bucket<T> = {
    items: T[];
    idleTimer: ReturnType<typeof setTimeout> | null;
    maxTimer: ReturnType<typeof setTimeout> | null;
    onFire: (items: T[]) => void;
  };

  const buckets = new Map<string, Bucket<unknown>>();

  function fire(key: string): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    buckets.delete(key);
    if (bucket.idleTimer) clearTimeout(bucket.idleTimer);
    if (bucket.maxTimer) clearTimeout(bucket.maxTimer);
    const items = bucket.items;
    if (items.length > 0) {
      bucket.onFire(items);
    }
  }

  function resetIdle(key: string, bucket: Bucket<unknown>): void {
    if (bucket.idleTimer) clearTimeout(bucket.idleTimer);
    bucket.idleTimer = setTimeout(() => fire(key), idleMs);
  }

  return {
    schedule<T>(key: string, item: T, onFire: (items: T[]) => void): void {
      let bucket = buckets.get(key) as Bucket<T> | undefined;
      if (!bucket) {
        bucket = {
          items: [],
          idleTimer: null,
          maxTimer: null,
          onFire,
        };
        buckets.set(key, bucket as Bucket<unknown>);
        bucket.maxTimer = setTimeout(() => fire(key), maxWaitMs);
      }
      bucket.items.push(item);
      bucket.onFire = onFire;
      resetIdle(key, bucket as Bucket<unknown>);
    },

    touch(key: string): void {
      const bucket = buckets.get(key);
      if (!bucket) return;
      resetIdle(key, bucket);
    },

    clearAll(): void {
      for (const key of [...buckets.keys()]) {
        const bucket = buckets.get(key);
        if (!bucket) continue;
        if (bucket.idleTimer) clearTimeout(bucket.idleTimer);
        if (bucket.maxTimer) clearTimeout(bucket.maxTimer);
        buckets.delete(key);
      }
    },
  };
}
