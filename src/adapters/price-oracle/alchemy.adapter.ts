import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { FiatCurrency, Rate } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

// Alchemy Prices API oracle. Uses `/prices/v1/{apiKey}/tokens/by-symbol`, the
// batch-by-symbol endpoint that returns spot USD prices for a list of ticker
// symbols in a single request. Cached in the shared CacheStore (30s TTL by
// default) so a burst of invoice creations hits the upstream once.
//
// Placement in the chain: Alchemy shares the same API key already wired for
// EVM RPC + Notify, so when the operator has Alchemy set up this adapter
// participates without any extra credentials. The Prices API is a premium
// feature on some Alchemy plans; whenever the call fails (HTTP error, 403
// quota, timeout, unmapped symbol, malformed body) we delegate to the next
// link rather than blocking a quote.
//
// Symbol mapping: Alchemy keys by ticker symbol directly (unlike CoinGecko /
// CoinCap which need coin-ids), so no symbol map is required for the majors.
// The `symbolOverrides` escape hatch exists for the rare case where Alchemy
// lists a rebranded ticker under a different symbol than the on-chain token.
//
// USD-only: the endpoint returns USD prices; non-USD fiat quotes are
// delegated to `fallback` rather than cross-rating.

export interface AlchemyPriceConfig {
  cache: CacheStore;
  fallback: PriceOracle;
  apiKey: string;
  logger?: Logger;
  ttlSeconds?: number;
  timeoutMs?: number;
  // Ticker → ticker override. Defaults to identity (pass-through).
  symbolOverrides?: Readonly<Record<string, string>>;
  // Base URL override (tests + private mirrors). Default
  // "https://api.g.alchemy.com/prices/v1".
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface AlchemyPriceRow {
  readonly symbol?: string;
  readonly prices?: ReadonlyArray<{ readonly currency?: string; readonly value?: string }>;
  readonly error?: { readonly message?: string };
}

interface AlchemyPriceResponse {
  readonly data?: readonly AlchemyPriceRow[];
}

export function alchemyPriceOracle(config: AlchemyPriceConfig): PriceOracle {
  const cache = config.cache;
  const fallback = config.fallback;
  const logger = config.logger;
  const ttlSeconds = config.ttlSeconds ?? 30;
  const timeoutMs = config.timeoutMs ?? 2500;
  const baseUrl = (config.baseUrl ?? "https://api.g.alchemy.com/prices/v1").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const overrides: Record<string, string> = { ...(config.symbolOverrides ?? {}) };

  function alchemySymbolFor(symbol: TokenSymbol): string {
    const upper = symbol.toUpperCase();
    return overrides[upper] ?? upper;
  }

  async function fetchUsdRates(tokens: readonly TokenSymbol[]): Promise<Record<string, string>> {
    if (tokens.length === 0) return {};

    // Cache key is keyed by the sorted upstream symbol set so repeat lookups
    // for the same token set hit a single entry.
    const mapping = tokens.map((t) => [t, alchemySymbolFor(t)] as const);
    const upstreamSymbols = Array.from(new Set(mapping.map(([, s]) => s))).sort();
    const cacheKey = `alchemy:price:usd:${upstreamSymbols.join(",")}`;
    const cached = await cache.getJSON<Record<string, string>>(cacheKey);
    if (cached !== null) return cached;

    const query = upstreamSymbols
      .map((s) => `symbols=${encodeURIComponent(s)}`)
      .join("&");
    const url = `${baseUrl}/${encodeURIComponent(config.apiKey)}/tokens/by-symbol?${query}`;
    const headers: Record<string, string> = { accept: "application/json" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body: AlchemyPriceResponse | null;
    try {
      const res = await doFetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`alchemy prices returned ${res.status}`);
      }
      body = (await res.json()) as AlchemyPriceResponse | null;
    } finally {
      clearTimeout(timer);
    }

    const bySymbol = new Map<string, string>();
    if (body !== null && Array.isArray(body.data)) {
      for (const row of body.data) {
        if (typeof row.symbol !== "string") continue;
        if (!Array.isArray(row.prices)) continue;
        const usd = row.prices.find(
          (p: { currency?: string; value?: string }) => p.currency?.toLowerCase() === "usd"
        );
        const raw = usd?.value;
        if (typeof raw !== "string" || raw.length === 0) continue;
        const parsed = Number.parseFloat(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) continue;
        bySymbol.set(row.symbol.toUpperCase(), formatRate(raw));
      }
    }

    const out: Record<string, string> = {};
    for (const [token, upstream] of mapping) {
      const v = bySymbol.get(upstream);
      if (v !== undefined) out[token] = v;
    }
    // Skip caching empty responses so a single malformed 200 doesn't poison
    // the TTL window — matches coingecko.adapter's review-fix behavior.
    if (Object.keys(out).length > 0) {
      await cache.putJSON(cacheKey, out, { ttlSeconds });
    }
    return out;
  }

  return {
    async tokenToFiat(token: TokenSymbol, fiatCurrency: FiatCurrency): Promise<Rate> {
      if (fiatCurrency.toUpperCase() !== "USD") {
        return fallback.tokenToFiat(token, fiatCurrency);
      }
      try {
        const rates = await fetchUsdRates([token]);
        const rate = rates[token];
        if (rate !== undefined) return { rate, at: now() };
      } catch (err) {
        logger?.warn("alchemy tokenToFiat failed; falling back", {
          token,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return fallback.tokenToFiat(token, fiatCurrency);
    },

    async fiatToTokenAmount(fiatAmount, token, fiatCurrency, decimals) {
      if (fiatCurrency.toUpperCase() !== "USD") {
        return fallback.fiatToTokenAmount(fiatAmount, token, fiatCurrency, decimals);
      }
      let rateStr: string | undefined;
      try {
        const rates = await fetchUsdRates([token]);
        rateStr = rates[token];
      } catch (err) {
        logger?.warn("alchemy fiatToTokenAmount failed; falling back", {
          token,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      if (rateStr === undefined) {
        return fallback.fiatToTokenAmount(fiatAmount, token, fiatCurrency, decimals);
      }
      const scaled = scaleDecimal(fiatAmount, decimals);
      const rateScaled = scaleDecimal(rateStr, decimals);
      if (rateScaled === 0n) {
        throw new Error(`alchemy oracle: zero rate for ${token}`);
      }
      const amountRaw = (scaled * BigInt(10) ** BigInt(decimals)) / rateScaled;
      return { amountRaw: amountRaw.toString(), rate: rateStr };
    },

    async getUsdRates(tokens) {
      let live: Record<string, string> = {};
      try {
        live = await fetchUsdRates(tokens);
      } catch (err) {
        logger?.warn("alchemy getUsdRates failed; using fallback only", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
      const missing = tokens.filter((t) => live[t] === undefined);
      const fromFallback = missing.length > 0 ? await fallback.getUsdRates(missing) : {};
      return { ...fromFallback, ...live };
    }
  };
}

function formatRate(value: string): string {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  return parsed.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

function scaleDecimal(value: string, decimals: number): bigint {
  const [wholeStr, fracStr = ""] = value.split(".");
  const frac = (fracStr + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(wholeStr ?? "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0");
}
