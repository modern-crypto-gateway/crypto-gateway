// Minimal KV interface that cleanly covers CF Workers KV, Redis (ioredis + Upstash HTTP),
// an in-process Map, and a libSQL-table-backed fallback. Intentionally excludes
// pub/sub and atomic increment — those are out of scope for v2 caching; we use
// the DB for anything that needs stronger semantics.

export interface CacheListResult {
  keys: readonly string[];
  // Cursor to resume pagination. Undefined when exhausted.
  cursor?: string;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  getJSON<T>(key: string): Promise<T | null>;

  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  putJSON<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void>;

  delete(key: string): Promise<void>;

  // CF KV's list semantics: prefix scan, page via cursor.
  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<CacheListResult>;
}
