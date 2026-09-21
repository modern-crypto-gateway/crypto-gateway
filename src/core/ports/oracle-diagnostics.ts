// Process-local ring buffer of recent price-oracle provider failures.
//
// The oracle fallback chain (CoinGecko → Alchemy → CoinCap → Binance → noop)
// deliberately swallows each provider's error and falls through to the next
// link, so by the time `warmRateCache` sees "chain returned nothing" the
// per-provider reasons are gone. Each adapter records its failure here on
// the way past; the rate-window's failure alert reads the buffer back so
// the on-call sees WHICH providers failed and WHY (429 rate-limited, DNS,
// timeout, unmapped symbol…) instead of a bare "no rates".
//
// Scope: module-level state, so it lives for the lifetime of the isolate /
// process. On Workers that means the cron's own invocation populates and
// reads it within the same tick — which is exactly when it matters. It is
// diagnostics only: never consulted for pricing decisions.

export interface OracleFailure {
  provider: string;
  // Unix ms.
  at: number;
  error: string;
  // Token symbols the failed call was asked for, when known.
  tokens?: readonly string[];
}

const MAX_ENTRIES = 25;
const recent: OracleFailure[] = [];

export function recordOracleFailure(failure: Omit<OracleFailure, "at"> & { at?: number }): void {
  recent.push({
    provider: failure.provider,
    at: failure.at ?? Date.now(),
    error: failure.error.slice(0, 500),
    ...(failure.tokens !== undefined ? { tokens: [...failure.tokens] } : {})
  });
  while (recent.length > MAX_ENTRIES) recent.shift();
}

// Failures recorded within the last `windowMs` (default 15 minutes), oldest
// first. Returns a copy — callers may mutate freely.
export function recentOracleFailures(windowMs = 15 * 60 * 1000, now = Date.now()): OracleFailure[] {
  const cutoff = now - windowMs;
  return recent.filter((f) => f.at >= cutoff).map((f) => ({ ...f }));
}

export function clearOracleFailures(): void {
  recent.length = 0;
}
