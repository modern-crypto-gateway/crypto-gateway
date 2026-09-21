import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryCacheAdapter } from "../../adapters/cache/memory.adapter.js";
import type { AppDeps } from "../../core/app-deps.js";
import {
  RATE_ALERT_REPEAT_MS,
  RATE_CRON_STALE_ALERT_MS,
  RATE_REFRESH_RETRY_POLICY,
  RATES_FRESH_MS,
  RATES_MAX_STALE_MS,
  RateUnavailableError,
  snapshotRates,
  warmRateCache
} from "../../core/domain/rate-window.js";
import { clearOracleFailures, recordOracleFailure } from "../../core/ports/oracle-diagnostics.js";
import type { PriceOracle } from "../../core/ports/price-oracle.port.js";
import type { TokenSymbol } from "../../core/types/token.js";

// The rate-window's cache tiers are pure domain logic over `deps.cache`,
// `deps.clock`, `deps.priceOracle` and `deps.chains[].family` — no DB, no
// HTTP. A hand-rolled partial AppDeps keeps these tests sub-millisecond and
// lets us drive the clock across the freshness / staleness boundaries.

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const TOKENS = ["USDC", "ETH"] as TokenSymbol[];

// Zero the in-tick retry backoff so failing-cron tests don't sleep.
RATE_REFRESH_RETRY_POLICY.backoffMs = [0, 0];

interface Harness {
  deps: AppDeps;
  oracle: { getUsdRates: ReturnType<typeof vi.fn> };
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  setNow(ms: number): void;
  errorMessages(): string[];
  errorFields(prefix: string): Record<string, unknown> | undefined;
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
    },
    errorMessages: () => logger.error.mock.calls.map((c) => String(c[0])),
    errorFields: (prefix) => {
      const call = logger.error.mock.calls.find((c) => String(c[0]).startsWith(prefix));
      return call?.[1] as Record<string, unknown> | undefined;
    }
  };
}

const LIVE = { USDC: "1", ETH: "3000" };
const DOWN = async (): Promise<Record<string, string>> => {
  throw new Error("every provider down");
};

beforeEach(() => {
  clearOracleFailures();
});

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
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("tier 2: empty cache (fresh deploy, cron not yet run) refreshes inline instead of failing", async () => {
    const h = harness(async () => LIVE);
    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1);
    // A brand-new deployment has no cron history to compare against: no
    // dead-cron alert on the first request.
    expect(h.logger.error).not.toHaveBeenCalled();

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

    h.oracle.getUsdRates.mockImplementation(DOWN);
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
    h.oracle.getUsdRates.mockImplementation(DOWN);
    h.setNow(T0 + RATES_FRESH_MS + 60_000);

    await snapshotRates(h.deps, TOKENS);
    await snapshotRates(h.deps, TOKENS);
    await snapshotRates(h.deps, TOKENS);
    // 1 cron warm + exactly 1 inline attempt; the other two hit the backoff marker.
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(2);
  });

  it("throws RateUnavailableError only when the cache is empty AND the oracle chain fails", async () => {
    const h = harness(DOWN);
    await expect(snapshotRates(h.deps, TOKENS)).rejects.toBeInstanceOf(RateUnavailableError);
    // Two distinct alerts: the refresh failure itself, and the customer-facing
    // outcome (an invoice create actually returned 503).
    expect(h.errorMessages()).toEqual([
      expect.stringContaining("[RATE_REFRESH_FAILED]"),
      expect.stringContaining("[RATES_UNAVAILABLE]")
    ]);
  });

  it("throws RateUnavailableError when the last good entry is older than RATES_MAX_STALE_MS and the oracle chain fails", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);
    h.oracle.getUsdRates.mockImplementation(DOWN);
    h.setNow(T0 + RATES_MAX_STALE_MS + 1);

    await expect(snapshotRates(h.deps, TOKENS)).rejects.toThrow(/too stale/);
  });

  it("warmRateCache never overwrites the last good entry with a failed or empty result", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    h.oracle.getUsdRates.mockImplementation(DOWN);
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

describe("rate-window refresh resilience + alerting", () => {
  it("cron warm retries the whole chain within the tick and succeeds without alerting", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient blip " + calls);
      return LIVE;
    });
    await warmRateCache(h.deps);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(RATE_REFRESH_RETRY_POLICY.attempts);
    expect(h.logger.error).not.toHaveBeenCalled();
    h.setNow(T0 + 1_000);
    expect((await snapshotRates(h.deps, TOKENS)).rates).toEqual(LIVE);
  });

  it("alerts immediately on the first failed refresh with full diagnostics", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    h.oracle.getUsdRates.mockImplementation(async () => {
      recordOracleFailure({ provider: "coingecko", error: "coingecko returned 429", tokens: TOKENS });
      recordOracleFailure({ provider: "binance", error: "AbortError: This operation was aborted", tokens: ["ETH"] });
      throw new Error("every provider down");
    });
    h.setNow(T0 + 60_000);
    await warmRateCache(h.deps);

    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1 + RATE_REFRESH_RETRY_POLICY.attempts);
    const fields = h.errorFields("[RATE_REFRESH_FAILED]");
    expect(fields).toBeDefined();
    expect(fields).toMatchObject({
      alertKind: "failure",
      source: "cron",
      attempts: RATE_REFRESH_RETRY_POLICY.attempts,
      error: "every provider down",
      consecutiveFailures: 1,
      failingForSeconds: 0,
      lastSuccessAt: new Date(T0).toISOString(),
      cache: { present: true, ageSeconds: 60, tokenCount: 2 }
    });
    expect(fields!["impact"]).toContain("503 RATES_UNAVAILABLE at " + new Date(T0 + RATES_MAX_STALE_MS).toISOString());
    expect(fields!["providerFailures"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "coingecko", error: "coingecko returned 429" }),
        expect.objectContaining({ provider: "binance" })
      ])
    );
    expect(fields!["tokensRequested"]).toEqual(expect.arrayContaining(["USDC", "ETH"]));
    expect(Array.isArray(fields!["investigate"])).toBe(true);
  });

  it("repeat failures re-alert only every RATE_ALERT_REPEAT_MS, with the running count", async () => {
    const h = harness(DOWN);
    await warmRateCache(h.deps); // tick 1 → alert
    h.setNow(T0 + 60_000);
    await warmRateCache(h.deps); // tick 2 → suppressed
    h.setNow(T0 + 120_000);
    await warmRateCache(h.deps); // tick 3 → suppressed
    expect(h.errorMessages().filter((m) => m.startsWith("[RATE_REFRESH_FAILED]"))).toHaveLength(1);

    h.setNow(T0 + RATE_ALERT_REPEAT_MS);
    await warmRateCache(h.deps); // → re-alert
    const failed = h.logger.error.mock.calls.filter((c) => String(c[0]).startsWith("[RATE_REFRESH_FAILED]"));
    expect(failed).toHaveLength(2);
    expect(failed[1]![1]).toMatchObject({
      consecutiveFailures: 4,
      failingForSeconds: RATE_ALERT_REPEAT_MS / 1000,
      cache: { present: false }
    });
    expect((failed[1]![1] as { impact: string }).impact).toContain("FAILING NOW");
  });

  it("sends a recovery notice on the first success after failures", async () => {
    const h = harness(DOWN);
    await warmRateCache(h.deps);
    h.setNow(T0 + 60_000);
    await warmRateCache(h.deps);

    h.oracle.getUsdRates.mockImplementation(async () => LIVE);
    h.setNow(T0 + 120_000);
    await warmRateCache(h.deps);

    const recovered = h.errorFields("[RATE_REFRESH_RECOVERED]");
    expect(recovered).toMatchObject({
      alertKind: "recovery",
      source: "cron",
      failedAttempts: 2,
      outageSeconds: 120,
      lastError: "every provider down"
    });

    // Healthy again: a later success is silent.
    h.setNow(T0 + 180_000);
    await warmRateCache(h.deps);
    expect(h.errorMessages().filter((m) => m.startsWith("[RATE_REFRESH_RECOVERED]"))).toHaveLength(1);
  });

  it("inline refresh failure alerts too (request path), once per repeat window", async () => {
    const h = harness(DOWN);
    await expect(snapshotRates(h.deps, TOKENS)).rejects.toBeInstanceOf(RateUnavailableError);
    const fields = h.errorFields("[RATE_REFRESH_FAILED]");
    expect(fields).toMatchObject({ source: "inline", attempts: 1, cache: { present: false } });
    expect((fields as { impact: string }).impact).toContain("FAILING NOW");
  });

  it("dead-cron watchdog: a stale entry with no recent refresh attempt alerts once per window", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    h.setNow(T0 + RATE_CRON_STALE_ALERT_MS + 60_000);
    // Entry is 6 min old: still tier-1 fresh, but the cron should have
    // rewritten it five times by now.
    const snap = await snapshotRates(h.deps, TOKENS);
    expect(snap.rates).toEqual(LIVE);
    expect(h.oracle.getUsdRates).toHaveBeenCalledTimes(1);
    const fields = h.errorFields("[RATE_CRON_STALE]");
    expect(fields).toMatchObject({
      alertKind: "failure",
      lastCacheWriteAt: new Date(T0).toISOString(),
      minutesSinceLastWrite: 6,
      lastRefreshFailureAt: null
    });

    await snapshotRates(h.deps, TOKENS);
    expect(h.errorMessages().filter((m) => m.startsWith("[RATE_CRON_STALE]"))).toHaveLength(1);
  });

  it("dead-cron watchdog stays quiet when the cron IS running but the oracles are failing", async () => {
    const h = harness(async () => LIVE);
    await warmRateCache(h.deps);

    h.oracle.getUsdRates.mockImplementation(DOWN);
    h.setNow(T0 + RATE_CRON_STALE_ALERT_MS + 30_000);
    await warmRateCache(h.deps); // records lastFailedAt → RATE_REFRESH_FAILED fires

    h.setNow(T0 + RATE_CRON_STALE_ALERT_MS + 60_000);
    await snapshotRates(h.deps, TOKENS);
    expect(h.errorMessages().some((m) => m.startsWith("[RATE_REFRESH_FAILED]"))).toBe(true);
    expect(h.errorMessages().some((m) => m.startsWith("[RATE_CRON_STALE]"))).toBe(false);
  });

  it("RATES_UNAVAILABLE alert is deduped across a burst of failing invoice creates", async () => {
    const h = harness(DOWN);
    await expect(snapshotRates(h.deps, TOKENS)).rejects.toBeInstanceOf(RateUnavailableError);
    await expect(snapshotRates(h.deps, TOKENS)).rejects.toBeInstanceOf(RateUnavailableError);
    await expect(snapshotRates(h.deps, TOKENS)).rejects.toBeInstanceOf(RateUnavailableError);
    expect(h.errorMessages().filter((m) => m.startsWith("[RATES_UNAVAILABLE]"))).toHaveLength(1);
    expect(h.errorMessages().filter((m) => m.startsWith("[RATE_REFRESH_FAILED]"))).toHaveLength(1);
  });
});
