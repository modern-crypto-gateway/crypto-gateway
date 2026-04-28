import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { FiatCurrency, Rate } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

// CoinGecko price oracle. Uses the free /simple/price endpoint (API key
// optional via the `x-cg-demo-api-key` / `x-cg-pro-api-key` header). Results
// are cached in the shared CacheStore (30s TTL by default) so a burst of
// invoice creations against the same token symbol hits the upstream once.
//
// Fallback behavior: whenever the live lookup fails (HTTP error, timeout,
// symbol not mapped) we delegate to `fallback`. In practice, the fallback is
// the static-peg adapter, which serves 1:1 for stables and configured
// override rates for volatile natives — the gateway keeps quoting rather
// than 500-ing when CoinGecko is slow.
//
// Symbol mapping: CoinGecko keys its API by coin-id, not ticker. We ship a
// conservative default map covering the tokens we actively support; operators
// can extend via `symbolMap`. An unmapped symbol falls through to `fallback`
// rather than guessing — guessing has produced real mis-quotes in the past
// (SOL the token vs. SOLA the unrelated token both have "SOL" in names).

export interface CoingeckoConfig {
  cache: CacheStore;
  fallback: PriceOracle;
  logger?: Logger;
  // Optional pro/demo API key. If set, sent via `x-cg-pro-api-key` (when
  // `plan === "pro"`) or `x-cg-demo-api-key` (default) — operators pick via
  // `plan` below to avoid silently sending the wrong header.
  apiKey?: string;
  plan?: "pro" | "demo";
  // Hard cache eviction TTL in seconds. Default 600 (10 min). The cache
  // entry is *served stale* once `freshSeconds` elapses (see below); this
  // longer TTL only kicks in if the oracle stays unreachable past the
  // eviction window. Independent from `freshSeconds`.
  ttlSeconds?: number;
  // Freshness window in seconds. Default 30. Cache hits within this window
  // return immediately. Hits AFTER this window but before `ttlSeconds`
  // return the stale value AND fire a background refresh so the next
  // request sees fresh data — stale-while-revalidate. This is the key
  // optimization that makes invoice creation sub-second on USD-pegged
  // invoices: only the first-ever request (truly cold cache) pays the
  // full upstream latency; every subsequent invoice creation hits cache.
  freshSeconds?: number;
  // Request timeout in ms. Default 2500 — CoinGecko p99 is ~700ms in
  // practice; anything slower than this we'd rather serve the fallback.
  timeoutMs?: number;
  // Token symbol → coingecko id. Merged on top of COINGECKO_DEFAULT_SYMBOL_MAP.
  symbolMap?: Readonly<Record<string, string>>;
  // Base URL override (tests + private mirrors). Default
  // "https://api.coingecko.com/api/v3".
  baseUrl?: string;
  // fetch override for tests.
  fetch?: typeof fetch;
  // Clock — tests inject for deterministic rate timestamps.
  now?: () => Date;
}

// Default map: ticker → coingecko coin-id. Cover the families wired in this
// repo today (EVM natives + EVM stables + Solana + Tron). Extend via
// `symbolMap` for anything custom.
export const COINGECKO_DEFAULT_SYMBOL_MAP: Readonly<Record<string, string>> = {
  // Major natives
  ETH: "ethereum",
  BNB: "binancecoin",
  MATIC: "matic-network",
  POL: "matic-network",
  AVAX: "avalanche-2",
  SOL: "solana",
  TRX: "tron",
  BTC: "bitcoin",
  LTC: "litecoin",
  // Stablecoins
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  PYUSD: "paypal-usd",
  USDP: "paxos-standard"
};

export function coingeckoPriceOracle(config: CoingeckoConfig): PriceOracle {
  const cache = config.cache;
  const fallback = config.fallback;
  const logger = config.logger;
  const ttlSeconds = config.ttlSeconds ?? 600;
  // Default freshness 90s: longer than the 60s scheduled-jobs cron tick
  // that warms the cache, so the merchant's invoice-create reads always
  // see fresh rates between cron runs. SWR still kicks in if the cron
  // ever stalls (worker outage, deploy gap), serving the last good value
  // while a background refresh recovers.
  const freshSeconds = config.freshSeconds ?? 90;
  const timeoutMs = config.timeoutMs ?? 2500;
  const baseUrl = (config.baseUrl ?? "https://api.coingecko.com/api/v3").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const symbolMap: Record<string, string> = {
    ...COINGECKO_DEFAULT_SYMBOL_MAP,
    ...(config.symbolMap ?? {})
  };

  function coinIdFor(symbol: TokenSymbol): string | undefined {
    return symbolMap[symbol.toUpperCase()];
  }

  async function fetchSpotUsd(
    tokens: readonly TokenSymbol[],
    fiat: FiatCurrency
  ): Promise<Record<string, string>> {
    const pairs = tokens
      .map((t) => [t, coinIdFor(t)] as const)
      .filter((p): p is readonly [TokenSymbol, string] => p[1] !== undefined);
    if (pairs.length === 0) return {};

    const cacheKey = `coingecko:price:${fiat.toLowerCase()}:${pairs
      .map(([, id]) => id)
      .sort()
      .join(",")}`;

    // Stale-while-revalidate. The cache stores `{ rates, freshUntil }`;
    // `freshUntil` says when the entry stops being "fresh enough" to
    // return without checking upstream. The hard `ttlSeconds` is the
    // eviction window — entries past `freshUntil` but before TTL serve
    // stale to the caller while we kick a background refresh, so the
    // very next request gets fresh data. The only request that pays
    // upstream latency is the truly-cold-cache case (first ever, or
    // after `ttlSeconds` of inactivity).
    interface CachedEntry {
      readonly rates: Record<string, string>;
      readonly freshUntil: number;
    }
    const cached = await cache.getJSON<CachedEntry>(cacheKey);
    const nowMs = now().getTime();
    if (cached !== null) {
      if (nowMs < cached.freshUntil) {
        return cached.rates;
      }
      // Stale: return immediately, refresh in the background. We don't
      // await — failures here are silent (logged via the synchronous-path
      // catch on the next miss); the user-facing request returns the
      // stale rates which are still well within the operator's chosen
      // freshness budget for "good-enough during oracle outages".
      void doRefresh(pairs, fiat, cacheKey).catch((err) => {
        logger?.warn("coingecko swr refresh failed; serving stale", {
          fiat,
          error: err instanceof Error ? err.message : String(err)
        });
      });
      return cached.rates;
    }

    return doRefresh(pairs, fiat, cacheKey);
  }

  async function doRefresh(
    pairs: ReadonlyArray<readonly [TokenSymbol, string]>,
    fiat: FiatCurrency,
    cacheKey: string
  ): Promise<Record<string, string>> {
    const ids = Array.from(new Set(pairs.map(([, id]) => id))).join(",");
    const url = `${baseUrl}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(fiat.toLowerCase())}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.apiKey !== undefined) {
      const header = config.plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key";
      headers[header] = config.apiKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body: unknown;
    try {
      const res = await doFetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`coingecko returned ${res.status}`);
      }
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }

    // Response shape: { <coin-id>: { <fiat-lower>: <number> } }
    const out: Record<string, string> = {};
    const byId = body as Record<string, Record<string, number>> | null | undefined;
    if (byId !== null && typeof byId === "object") {
      for (const [symbol, id] of pairs) {
        const row = byId[id];
        const value = row?.[fiat.toLowerCase()];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          out[symbol] = formatRate(value);
        }
      }
    }
    // Only cache a non-empty result — a 200 with a malformed/empty body would
    // otherwise poison the TTL window and keep serving the fallback even
    // after CoinGecko recovers.
    if (Object.keys(out).length > 0) {
      const freshUntil = now().getTime() + freshSeconds * 1000;
      await cache.putJSON(cacheKey, { rates: out, freshUntil }, { ttlSeconds });
    }
    return out;
  }

  return {
    async tokenToFiat(token: TokenSymbol, fiatCurrency: FiatCurrency): Promise<Rate> {
      try {
        const rates = await fetchSpotUsd([token], fiatCurrency);
        const rate = rates[token];
        if (rate !== undefined) return { rate, at: now() };
      } catch (err) {
        logger?.warn("coingecko tokenToFiat failed; falling back", {
          token,
          fiat: fiatCurrency,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return fallback.tokenToFiat(token, fiatCurrency);
    },

    async fiatToTokenAmount(fiatAmount, token, fiatCurrency, decimals) {
      let rateStr: string | undefined;
      try {
        const rates = await fetchSpotUsd([token], fiatCurrency);
        rateStr = rates[token];
      } catch (err) {
        logger?.warn("coingecko fiatToTokenAmount failed; falling back", {
          token,
          fiat: fiatCurrency,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      if (rateStr === undefined) {
        return fallback.fiatToTokenAmount(fiatAmount, token, fiatCurrency, decimals);
      }
      // Use the same scaled-BigInt arithmetic as static-peg so the conversion
      // matches bit-for-bit on USDC regardless of which oracle served the
      // quote. Keeping parity is important for the rate-window snapshot.
      const scaled = scaleDecimal(fiatAmount, decimals);
      const rateScaled = scaleDecimal(rateStr, decimals);
      if (rateScaled === 0n) {
        throw new Error(`coingecko oracle: zero rate for ${token}`);
      }
      const amountRaw = (scaled * BigInt(10) ** BigInt(decimals)) / rateScaled;
      return { amountRaw: amountRaw.toString(), rate: rateStr };
    },

    async getUsdRates(tokens) {
      // Batch-fetch whatever coingecko knows; layer the fallback on top for
      // anything it misses (pegged stables the fallback knows are "1", etc.).
      let live: Record<string, string> = {};
      try {
        // USD rates are the hot path (rate-window) — the underlying
        // /simple/price supports batching by vs_currency.
        live = await fetchSpotUsd(tokens, "USD" as FiatCurrency);
      } catch (err) {
        logger?.warn("coingecko getUsdRates failed; using fallback only", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
      const missing = tokens.filter((t) => live[t] === undefined);
      const staticRates = missing.length > 0 ? await fallback.getUsdRates(missing) : {};
      return { ...staticRates, ...live };
    }
  };
}

// Format a JS number into a decimal string without scientific notation. Caps
// at 10 decimals — far more than needed for USD-denominated token prices and
// safely inside the 36-decimal limit the AmountRaw math tolerates.
function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

// Same scaling helper static-peg uses — duplicated on purpose so each adapter
// remains self-contained (no cross-adapter imports; avoids a circular layer
// between static-peg and coingecko).
function scaleDecimal(value: string, decimals: number): bigint {
  const [wholeStr, fracStr = ""] = value.split(".");
  const frac = (fracStr + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(wholeStr ?? "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0");
}
