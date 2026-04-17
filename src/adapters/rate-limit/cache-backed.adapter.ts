import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { RateLimiter, RateLimitResult } from "../../core/ports/rate-limit.port.ts";

// Fixed-window rate limiter backed by a CacheStore. Per window, keys are
// namespaced `rl:<key>:<windowStartMs>` so each window gets its own counter
// that naturally expires via the cache's TTL. Rolling from one window to the
// next just lands on a fresh key.
//
// Consistency: cache `.get` + `.put` is NOT atomic. Under heavy concurrent
// burst on eventually consistent stores (CF KV) this over-admits by up to the
// concurrency level. In-memory and Redis backends (future) are tighter. For
// strict single-digit-accurate limits on Workers, wire the Cloudflare
// `ratelimits` binding via cloudflare.adapter.ts instead.

export interface CacheBackedRateLimiterConfig {
  // Clock injection for tests. Defaults to `() => Date.now()`.
  now?: () => number;
  // Minimum TTL to set when writing counters. Cache implementations with TTL
  // floors (CF KV = 60s) would clamp this anyway; specifying it makes the
  // behavior explicit + portable. Defaults to 60.
  minTtlSeconds?: number;
}

export function cacheBackedRateLimiter(
  cache: CacheStore,
  config: CacheBackedRateLimiterConfig = {}
): RateLimiter {
  const now = config.now ?? (() => Date.now());
  const minTtl = config.minTtlSeconds ?? 60;

  return {
    async consume({ key, limit, windowSeconds }): Promise<RateLimitResult> {
      const windowMs = windowSeconds * 1000;
      const currentTime = now();
      const windowStart = Math.floor(currentTime / windowMs) * windowMs;
      const resetMs = windowStart + windowMs;
      const cacheKey = `rl:${key}:${windowStart}`;

      const existingRaw = await cache.get(cacheKey);
      const existing = existingRaw === null ? 0 : Number.parseInt(existingRaw, 10) || 0;

      if (existing >= limit) {
        return { allowed: false, limit, remaining: 0, resetMs };
      }

      const next = existing + 1;
      // TTL = window + 1s so the key outlives its window by a beat, preventing
      // a race where a tick-boundary read sees the old window as "missing" too
      // early. Clamped against the cache's minimum TTL floor.
      const ttl = Math.max(minTtl, windowSeconds + 1);
      await cache.put(cacheKey, String(next), { ttlSeconds: ttl });
      return { allowed: true, limit, remaining: Math.max(0, limit - next), resetMs };
    }
  };
}
