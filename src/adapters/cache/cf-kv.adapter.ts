import type { KVNamespace } from "@cloudflare/workers-types";
import type { CacheListResult, CacheStore } from "../../core/ports/cache.port.ts";

// CacheStore over a Cloudflare KV binding. KV's semantics:
//   - get/put/delete are async and eventually consistent across the edge
//   - TTL has a minimum of 60 seconds (shorter values silently round up)
//   - list() returns { keys, list_complete, cursor } and supports prefix+cursor pagination
//
// We surface KV's eventual consistency unchanged — callers treat cache reads
// as advisory anyway.

export function cfKvAdapter(kv: KVNamespace): CacheStore {
  return {
    async get(key) {
      return kv.get(key, "text");
    },

    async getJSON<T>(key: string): Promise<T | null> {
      return (await kv.get(key, "json")) as T | null;
    },

    async put(key, value, opts) {
      const putOpts: { expirationTtl?: number } = {};
      if (opts?.ttlSeconds !== undefined) {
        // KV's minimum TTL is 60s. Clamp silently — emitting a warning on every
        // write would be noisy, and the semantic (cache for a short window) is
        // preserved even if the effective TTL is slightly longer.
        putOpts.expirationTtl = Math.max(60, opts.ttlSeconds);
      }
      await kv.put(key, value, putOpts);
    },

    async putJSON<T>(key: string, value: T, opts?: { ttlSeconds?: number }) {
      const putOpts: { expirationTtl?: number } = {};
      if (opts?.ttlSeconds !== undefined) {
        putOpts.expirationTtl = Math.max(60, opts.ttlSeconds);
      }
      await kv.put(key, JSON.stringify(value), putOpts);
    },

    async putIfAbsent(key, value, opts) {
      // KV has no CAS. Best-effort: check, then write. Race window ≈ KV's
      // propagation latency (~30s-1min). Callers relying on this for
      // mutual exclusion should treat it as advisory and be idempotent
      // downstream — the pool-refill path, for instance, relies on the
      // DB's UNIQUE(family, address_index) constraint to reject dupes if
      // two racers both pass the putIfAbsent check.
      const existing = await kv.get(key);
      if (existing !== null) return false;
      const putOpts: { expirationTtl?: number } = {};
      if (opts?.ttlSeconds !== undefined) putOpts.expirationTtl = Math.max(60, opts.ttlSeconds);
      await kv.put(key, value, putOpts);
      return true;
    },

    async delete(key) {
      await kv.delete(key);
    },

    async list(prefix, opts): Promise<CacheListResult> {
      const listArgs: { prefix: string; limit?: number; cursor?: string } = { prefix };
      if (opts?.limit !== undefined) listArgs.limit = opts.limit;
      if (opts?.cursor !== undefined) listArgs.cursor = opts.cursor;
      const result = await kv.list(listArgs);
      // KV returns a `KVNamespaceListResult` with `list_complete` (boolean)
      // and `cursor` (present only when !list_complete). Narrow via the flag.
      const keys = result.keys.map((k) => k.name);
      if (result.list_complete) {
        return { keys };
      }
      return { keys, cursor: result.cursor };
    }
  };
}
