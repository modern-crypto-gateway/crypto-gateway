import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { FiatCurrency, Rate } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

// Binance public market-data oracle. Third-line fallback behind CoinGecko and
// CoinCap. Keyless, no rate-limit to speak of for /api/v3/ticker/price, but
// coverage is restricted to tokens Binance lists as a spot pair. We quote USD
// via the USDT pair (USDT is a hard-pegged stable — within a few basis points
// of USD in normal conditions; acceptable as a tertiary fallback).
//
// For USDT itself we skip the API and return "1" directly (Binance has no
// "USDTUSDT" pair). For USDC, the USDCUSDT pair returns ~1.0 which matches
// how every downstream consumer treats USDC. For volatile tokens (ETH, BNB,
// SOL, ...) the USDT-pair price is the canonical spot the entire industry
// uses for intra-second pricing.
//
// Non-USD fiat is delegated to `fallback` — Binance does have some fiat
// pairs (EUR/GBP/TRY), but coverage is patchy and we'd rather keep this
// adapter's behavior predictable than chase a long tail of fiat markets.

export interface BinanceConfig {
  cache: CacheStore;
  fallback: PriceOracle;
  logger?: Logger;
  ttlSeconds?: number;
  timeoutMs?: number;
  // Ticker → Binance symbol override. Defaults built on `<TICKER>USDT`; a few
  // tokens have historical/rebranded pairs (POL vs MATIC during the Polygon
  // migration) so the override map is there for those edge cases.
  symbolOverrides?: Readonly<Record<string, string>>;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

// Binance retired MATIC spot trading and lists POL as the Polygon native
// asset (MATIC/POL migration landed in Binance markets mid-2024). Keep the
// two tickers pointing at POL to avoid 400s from the API.
export const BINANCE_DEFAULT_SYMBOL_OVERRIDES: Readonly<Record<string, string>> = {
  MATIC: "POLUSDT",
  POL: "POLUSDT"
};

// Stables handled without an HTTP call. USDT is 1 by definition on this
// adapter (everything else is USDT-denominated); USDC is within a few bps
// of USDT but the Binance USDCUSDT pair exists and gives a live read — we
// let that go to the HTTP path so a depegging event surfaces.
const USDT_SELF_PEG: Readonly<Record<string, string>> = {
  USDT: "1"
};

export function binancePriceOracle(config: BinanceConfig): PriceOracle {
  const cache = config.cache;
  const fallback = config.fallback;
  const logger = config.logger;
  const ttlSeconds = config.ttlSeconds ?? 30;
  const timeoutMs = config.timeoutMs ?? 2500;
  const baseUrl = (config.baseUrl ?? "https://api.binance.com").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const overrides: Record<string, string> = {
    ...BINANCE_DEFAULT_SYMBOL_OVERRIDES,
    ...(config.symbolOverrides ?? {})
  };

  function binanceSymbolFor(token: TokenSymbol): string | undefined {
    const upper = token.toUpperCase();
    if (USDT_SELF_PEG[upper] !== undefined) return undefined; // handled separately
    const override = overrides[upper];
    if (override !== undefined) return override;
    // Default: ticker + USDT (ETH -> ETHUSDT, SOL -> SOLUSDT, USDC -> USDCUSDT).
    return `${upper}USDT`;
  }

  async function fetchUsdRate(token: TokenSymbol): Promise<string | undefined> {
    const upper = token.toUpperCase();
    if (USDT_SELF_PEG[upper] !== undefined) return USDT_SELF_PEG[upper];

    const binanceSymbol = binanceSymbolFor(token);
    if (binanceSymbol === undefined) return undefined;

    const cacheKey = `binance:price:${binanceSymbol}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached;

    const url = `${baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      // 400 on an unknown symbol is expected for tokens we don't have a
      // Binance listing for (new chains, long-tail altcoins). Swallow and let
      // the chain fall through to static-peg instead of throwing.
      if (res.status === 400) return undefined;
      if (!res.ok) throw new Error(`binance returned ${res.status}`);
      const body = (await res.json()) as { symbol?: string; price?: string } | null;
      const price = body?.price;
      if (typeof price !== "string" || price.length === 0) return undefined;
      const parsed = Number.parseFloat(price);
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
      const formatted = formatRate(price);
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
        logger?.warn("binance tokenToFiat failed; falling back", {
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
        logger?.warn("binance fiatToTokenAmount failed; falling back", {
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
        throw new Error(`binance oracle: zero rate for ${token}`);
      }
      const amountRaw = (scaled * BigInt(10) ** BigInt(decimals)) / rateScaled;
      return { amountRaw: amountRaw.toString(), rate: rateStr };
    },

    async getUsdRates(tokens) {
      const live: Record<string, string> = {};
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
