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

  // Set `value` ONLY if `key` is currently absent. Returns true on success
  // (lock acquired), false on contention (someone else set it first). The
  // pool-refill path uses this as a mutex so concurrent order creations
  // don't both start HD-deriving the same address indices.
  //
  // Backend semantics vary:
  //   - memory: O(1) Map check+set (no race; same process).
  //   - CF KV: not natively atomic — CF KV has no CAS. We fall back to a
  //     "get; if null, put" pattern with a short check-interval to minimise
  //     the race window. Not perfect; good enough for a refill lock where
  //     double-derivation produces duplicate rows that the UNIQUE (family,
  //     address_index) constraint rejects at insert time anyway.
  //   - Redis (future): SET NX PX.
  putIfAbsent(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<boolean>;

  delete(key: string): Promise<void>;

  // CF KV's list semantics: prefix scan, page via cursor.
  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<CacheListResult>;
}
