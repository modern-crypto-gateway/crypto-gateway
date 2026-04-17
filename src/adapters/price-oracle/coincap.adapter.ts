import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { FiatCurrency, Rate } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

// CoinCap price oracle. Second-line fallback behind CoinGecko. Uses the free
// `/v2/assets/{id}` endpoint — keyless, ~1 req/sec budget in practice, covers
// the same major assets as CoinGecko.
//
// CoinCap only returns `priceUsd`; non-USD fiat quotes are computed via the
// upstream fiat adapter's USD rate. Because the domain today quotes only USD
// (rate-window, USD invoices), non-USD calls are delegated to `fallback`
// without further effort — the adapter never silently fabricates cross-rates.

export interface CoincapConfig {
  cache: CacheStore;
  fallback: PriceOracle;
  logger?: Logger;
  // Optional Messari API key. CoinCap v2 has been migrating under Messari's
  // ownership; basic /v2/assets calls still work keyless at the time of
  // writing, but operators who hit rate limits can set one.
  apiKey?: string;
  ttlSeconds?: number;
  timeoutMs?: number;
  symbolMap?: Readonly<Record<string, string>>;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

// Ticker → CoinCap asset-id. Defaults chosen to cover every symbol the repo
// currently supports. Extend via `symbolMap` for exotic tokens.
export const COINCAP_DEFAULT_SYMBOL_MAP: Readonly<Record<string, string>> = {
  ETH: "ethereum",
  BNB: "binance-coin",
  MATIC: "polygon-ecosystem-token",
  POL: "polygon-ecosystem-token",
  AVAX: "avalanche",
  SOL: "solana",
  TRX: "tron",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "multi-collateral-dai",
  PYUSD: "paypal-usd",
  USDP: "pax-dollar"
};

export function coincapPriceOracle(config: CoincapConfig): PriceOracle {
  const cache = config.cache;
  const fallback = config.fallback;
  const logger = config.logger;
  const ttlSeconds = config.ttlSeconds ?? 30;
  const timeoutMs = config.timeoutMs ?? 2500;
  const baseUrl = (config.baseUrl ?? "https://api.coincap.io/v2").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const symbolMap: Record<string, string> = {
    ...COINCAP_DEFAULT_SYMBOL_MAP,
    ...(config.symbolMap ?? {})
  };

  function assetIdFor(symbol: TokenSymbol): string | undefined {
    return symbolMap[symbol.toUpperCase()];
  }

  async function fetchUsdRate(token: TokenSymbol): Promise<string | undefined> {
    const id = assetIdFor(token);
    if (id === undefined) return undefined;

    const cacheKey = `coincap:usd:${id}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached;

    const url = `${baseUrl}/assets/${encodeURIComponent(id)}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.apiKey !== undefined) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) throw new Error(`coincap returned ${res.status}`);
      const body = (await res.json()) as { data?: { priceUsd?: string } } | null;
      const priceUsd = body?.data?.priceUsd;
      if (typeof priceUsd !== "string" || priceUsd.length === 0) return undefined;
      const parsed = Number.parseFloat(priceUsd);
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
      const formatted = formatRate(priceUsd);
      await cache.put(cacheKey, formatted, { ttlSeconds });
      return formatted;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async tokenToFiat(token: TokenSymbol, fiatCurrency: FiatCurrency): Promise<Rate> {
      if (fiatCurrency.toUpperCase() !== "USD") {
        return fallback.tokenToFiat(token, fiatCurrency);
      }
      try {
        const rate = await fetchUsdRate(token);
        if (rate !== undefined) return { rate, at: now() };
      } catch (err) {
        logger?.warn("coincap tokenToFiat failed; falling back", {
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
        rateStr = await fetchUsdRate(token);
      } catch (err) {
        logger?.warn("coincap fiatToTokenAmount failed; falling back", {
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
        throw new Error(`coincap oracle: zero rate for ${token}`);
      }
      const amountRaw = (scaled * BigInt(10) ** BigInt(decimals)) / rateScaled;
      return { amountRaw: amountRaw.toString(), rate: rateStr };
    },

    async getUsdRates(tokens) {
      const live: Record<string, string> = {};
      // CoinCap has no batch-by-ids endpoint on the free tier; issue per-id
      // lookups in parallel (small N — rate-window passes at most 6-10
      // symbols per tick). Each lookup is cached independently so the
      // per-token hit rate compounds.
      const lookups = await Promise.allSettled(
        tokens.map(async (t) => [t, await fetchUsdRate(t)] as const)
      );
      for (const r of lookups) {
        if (r.status === "fulfilled" && r.value[1] !== undefined) {
          live[r.value[0]] = r.value[1];
        }
      }
      const missing = tokens.filter((t) => live[t] === undefined);
      const fromFallback = missing.length > 0 ? await fallback.getUsdRates(missing) : {};
      return { ...fromFallback, ...live };
    }
  };
}

// Same scaling helpers as coingecko.adapter.ts / static-peg.adapter.ts. Kept
// local to avoid an adapter-level shared dependency.
function formatRate(value: string): string {
  // Parse-then-truncate so "1234.567890123456" and "0.00003456789" round-trip
  // to a stable 10-decimal string matching other adapters.
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  return parsed.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

function scaleDecimal(value: string, decimals: number): bigint {
  const [wholeStr, fracStr = ""] = value.split(".");
  const frac = (fracStr + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(wholeStr ?? "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0");
}
