import { describe, expect, it } from "vitest";
import { memoryCacheAdapter } from "../../adapters/cache/memory.adapter.js";
import { cacheBackedRateLimiter } from "../../adapters/rate-limit/cache-backed.adapter.js";

describe("cacheBackedRateLimiter", () => {
  it("allows up to `limit` consumes in one window, then denies", async () => {
    const limiter = cacheBackedRateLimiter(memoryCacheAdapter(), { minTtlSeconds: 1 });
    const results: Array<{ allowed: boolean; remaining: number }> = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await limiter.consume({ key: "merchant-a", limit: 3, windowSeconds: 60 });
      results.push({ allowed: r.allowed, remaining: r.remaining });
    }
    expect(results).toEqual([
      { allowed: true, remaining: 2 },
      { allowed: true, remaining: 1 },
      { allowed: true, remaining: 0 },
      { allowed: false, remaining: 0 },
      { allowed: false, remaining: 0 }
    ]);
  });

  it("separate keys have separate counters (no cross-tenant leakage)", async () => {
    const limiter = cacheBackedRateLimiter(memoryCacheAdapter(), { minTtlSeconds: 1 });
    // Exhaust key A.
    for (let i = 0; i < 3; i += 1) await limiter.consume({ key: "a", limit: 3, windowSeconds: 60 });
    // Key B should still have full quota.
    const b = await limiter.consume({ key: "b", limit: 3, windowSeconds: 60 });
    expect(b.allowed).toBe(true);
    expect(b.remaining).toBe(2);
  });

  it("rolls to a fresh bucket when the window advances", async () => {
    let fakeNow = 1_000_000;
    const limiter = cacheBackedRateLimiter(memoryCacheAdapter(), { minTtlSeconds: 1, now: () => fakeNow });

    // Use windowSeconds=60 -> windowMs=60000.
    for (let i = 0; i < 2; i += 1) await limiter.consume({ key: "k", limit: 2, windowSeconds: 60 });
    const third = await limiter.consume({ key: "k", limit: 2, windowSeconds: 60 });
    expect(third.allowed).toBe(false);

    // Advance the clock past the window boundary.
    fakeNow += 60_000;
    const fresh = await limiter.consume({ key: "k", limit: 2, windowSeconds: 60 });
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(1);
  });

  it("resetMs points at the end of the CURRENT window (windowStart + windowMs)", async () => {
    const now = 1_700_000_000_000; // some ms value
    const limiter = cacheBackedRateLimiter(memoryCacheAdapter(), { minTtlSeconds: 1, now: () => now });
    const result = await limiter.consume({ key: "x", limit: 10, windowSeconds: 60 });
    const windowMs = 60_000;
    const expectedStart = Math.floor(now / windowMs) * windowMs;
    expect(result.resetMs).toBe(expectedStart + windowMs);
    expect(result.resetMs).toBeGreaterThan(now);
  });

  it("returns allowed=false with remaining=0 every time after the first denial (no negative remaining)", async () => {
    const limiter = cacheBackedRateLimiter(memoryCacheAdapter(), { minTtlSeconds: 1 });
    for (let i = 0; i < 2; i += 1) await limiter.consume({ key: "k", limit: 2, windowSeconds: 60 });
    for (let i = 0; i < 5; i += 1) {
      const r = await limiter.consume({ key: "k", limit: 2, windowSeconds: 60 });
      expect(r.allowed).toBe(false);
      expect(r.remaining).toBe(0);
    }
  });
});
