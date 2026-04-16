import type { CacheListResult, CacheStore } from "../../core/ports/cache.port.ts";

interface Entry {
  value: string;
  expiresAt: number | null;
}

// In-process Map-backed cache. Used by tests and by Node when REDIS_URL is unset.
// Not shared across instances — for horizontal scale deployments, use the Redis adapter.

export function memoryCacheAdapter(): CacheStore {
  const store = new Map<string, Entry>();

  function isExpired(entry: Entry, now: number): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= now;
  }

  function readFresh(key: string): string | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (isExpired(entry, Date.now())) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key) {
      return readFresh(key);
    },

    async getJSON<T>(key: string): Promise<T | null> {
      const raw = readFresh(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    },

    async put(key, value, opts) {
      const expiresAt = opts?.ttlSeconds !== undefined ? Date.now() + opts.ttlSeconds * 1000 : null;
      store.set(key, { value, expiresAt });
    },

    async putJSON<T>(key: string, value: T, opts?: { ttlSeconds?: number }) {
      const expiresAt = opts?.ttlSeconds !== undefined ? Date.now() + opts.ttlSeconds * 1000 : null;
      store.set(key, { value: JSON.stringify(value), expiresAt });
    },

    async delete(key) {
      store.delete(key);
    },

    async list(prefix, opts): Promise<CacheListResult> {
      const limit = opts?.limit ?? 1000;
      const startAfter = opts?.cursor;
      const now = Date.now();

      const all: string[] = [];
      for (const [k, entry] of store) {
        if (!k.startsWith(prefix)) continue;
        if (isExpired(entry, now)) {
          store.delete(k);
          continue;
        }
        all.push(k);
      }
      all.sort();

      const startIdx = startAfter === undefined ? 0 : all.findIndex((k) => k > startAfter);
      const slice = startIdx === -1 ? [] : all.slice(startIdx, startIdx + limit);
      const result: CacheListResult =
        slice.length === limit && startIdx + limit < all.length
          ? { keys: slice, cursor: slice[slice.length - 1]! }
          : { keys: slice };
      return result;
    }
  };
}
