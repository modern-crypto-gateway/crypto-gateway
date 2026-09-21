import { describe, expect, it, vi } from "vitest";
import { memoryCacheAdapter } from "../../adapters/cache/memory.adapter.js";
import type { AppDeps } from "../../core/app-deps.js";
import {
  RATES_FRESH_MS,
  RATES_MAX_STALE_MS,
  RateUnavailableError,
  snapshotRates,
  warmRateCache
} from "../../core/domain/rate-window.js";
import type { PriceOracle } from "../../core/ports/price-oracle.port.js";
import type { TokenSymbol } from "../../core/types/token.js";

// The rate-window's cache tiers are pure domain logic over `deps.cache`,
// `deps.clock`, `deps.priceOracle` and `deps.chains[].family` — no DB, no
// HTTP. A hand-rolled partial AppDeps keeps these tests sub-millisecond and
// lets us drive the clock across the freshness / staleness boundaries.

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const TOKENS = ["USDC", "ETH"] as TokenSymbol[];

interface Harness {
  deps: AppDeps;
  oracle: { getUsdRates: ReturnType<typeof vi.fn> };
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  setNow(ms: number): void;
}

function harness(rates: () => Promise<Record<string, string>>): Harness {
  let nowMs = T0;
  const oracle = {
    getUsdRates: vi.fn(async (_tokens: readonly TokenSymbol[]) => rates())
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
  const deps = {
    clock: { now: () => new Date(nowMs) },
    cache: memoryCacheAdapter(),
    logger,
    priceOracle: oracle as unknown as PriceOracle,
    chains: [{ family: "evm" }]
  } as unknown as AppDeps;
  return {
    deps,
    oracle,
    logger,
    setNow: (ms) => {
      nowMs = ms;
    }
  };
}

const LIVE = { USDC: "1", ETH: "3000" };

describe("rate-window cache tiers", () => {
  it("tier 1: serves a fresh cron-warmed entry without touching the oracle", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1);

    h.setNow(T0 + 30_000);
    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("tier 2: empty cache (fresh deploy, cron not yet run) refreshes inline instead of failing", async () => {
    const h = harness(async () => LIVE);
    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1);

    // The inline warm wrote the shared entry: the next request is tier 1.
    const again = await snapshotRates(h.deps, TOKENS);
    expect(again.rates).toEqual(LIVE);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1);
  });

  it("tier 2: an entry older than RATES_FRESH_MS is refreshed inline (dead cron)", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    const fresher = { USDC: "1", ETH: "3100" };
    h.oracle.getUsdRates.mockImplementation(async () => fresher);
    h.setNow(T0 + RATES_FRESH_MS + 1);

    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(fresher);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(2);
  });

  it("tier 2: inline refresh is single-flighted across concurrent requests", async () => {
    let release!: (v: Record<string, string>) => void;
    const gate = new Promise<Record<string, string>>((resolve) => {
      release = resolve;
    });
    const h = harness(() => gate);

    const a = snapshotRates(h.deps, TOKENS);
    const b = snapshotRates(h.deps, TOKENS);
    const c = snapshotRates(h.deps, TOKENS);
    release(LIVE);
    const snaps = await Promise.all([a, b, c]);
    for (const s of snaps) expect(s.rates).toEqual(LIVE);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1);
  });

  it("tier 3: aged entry + oracle outage serves bounded-stale rates with a warning", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    h.oracle.getUsdRates.mockImplementation(async () => {
      throw new Error("every provider down");
    });
    h.setNow(T0 + RATES_FRESH_MS + 60_000);

    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("serving stale rates"),
      expect.objectContaining({ ageSeconds: expect.any(Number) })
    );
  });

  it("tier 3: an oracle chain that returns {} is treated as a failed refresh, not an empty rate map", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    h.oracle.getUsdRates.mockImplementation(async () => ({}));
    h.setNow(T0 + RATES_FRESH_MS + 60_000);

    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
  });

  it("backoff: after a failed inline refresh, the next request does not re-hit the oracle", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);
    h.oracle.getUsdRates.mockImplementation(async () => {
      throw new Error("down");
    });
    h.setNow(T0 + RATES_FRESH_MS + 60_000);

    await snapshotRates(h.deps, TOKENS);
    await snapshotRates(h.deps, TOKENS);
    await snapshotRates(h.deps, TOKENS);
    // 1 cron warm + exactly 1 inline attempt; the other two hit the backoff marker.
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(2);
  });

  it("throws RateUnavailableError only when the cache is empty AND the oracle chain fails", async () => {
    const h = harness(async () => {
      throw new Error("down");
    });
    await expect(snapshotRates(h.deps, TOKENS)).rejects.toBeInstanceOf(RateUnavailableError);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it("throws RateUnavailableError when the last good entry is older than RATES_MAX_STALE_MS and the oracle chain fails", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);
    h.oracle.getUsdRates.mockImplementation(async () => {
      throw new Error("down");
    });
    h.setNow(T0 + RATES_MAX_STALE_MS + 1);

    await expect(snapshotRates(h.deps, TOKENS)).rejects.toThrow(/too stale/);
  });

  it("warmRateCache never overwrites the last good entry with a failed or empty result", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    h.oracle.getUsdRates.mockImplementation(async () => {
      throw new Error("down");
    });
    await warmRateCache(h.deps);
    h.oracle.getUsdRates.mockImplementation(async () => ({}));
    await warmRateCache(h.deps);

    h.setNow(T0 + 1_000);
    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
  });

  it("tolerates a malformed cache entry by treating it as a miss", async () => {
    const h = harness(async () => LIVE);
    await h.deps.cache.putJSON("rates:usd:warmed", { garbage: true });
    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
  });
});
