import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import type { FiatCurrency, Rate } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

// Returns a 1:1 peg for stables. The cheapest possible PriceOracle — no network,
// no cache, no provider key. Used for local dev, tests, and deployments that
// only accept USD-pegged stablecoins (USDC, USDT, DAI, ...).
// For volatile tokens, pair with alchemy-prices or coingecko in Phase 4.

export interface StaticPegConfig {
  // Which symbols are considered 1:1 against USD. Defaults to the common USD stables.
  peggedSymbols?: readonly TokenSymbol[];
  // Optional per-token USD overrides for volatile natives (ETH, BNB, SOL, …)
  // so static-peg can serve multi-token USD quotes in dev and tests without
  // pulling a live oracle. Production deployments wire the Alchemy Prices
  // adapter instead of this one; when that's not available, operators can
  // plug realistic numbers in here and accept that they're stale.
  overrideRates?: Readonly<Record<string, string>>;
}

// Placeholder mid-range rates for volatile natives. Only used by dev/test;
// production mainnet requires a real oracle (Alchemy Prices or equivalent).
// Kept in a single map so operators see the assumptions at a glance.
const DEFAULT_NATIVE_RATES: Readonly<Record<string, string>> = {
  ETH: "2500",
  BNB: "600",
  MATIC: "0.60",
  POL: "0.60",
  AVAX: "30",
  SOL: "150",
  TRX: "0.25"
};

export function staticPegPriceOracle(config: StaticPegConfig = {}): PriceOracle {
  const pegged = new Set<string>(config.peggedSymbols ?? (["USDC", "USDT", "DAI", "DEV"] as TokenSymbol[]));
  const rates: Record<string, string> = { ...DEFAULT_NATIVE_RATES, ...(config.overrideRates ?? {}) };

  function rateFor(token: TokenSymbol): string | null {
    if (pegged.has(token)) return "1";
    const override = rates[token];
    if (override !== undefined) return override;
    return null;
  }

  return {
    async tokenToFiat(token: TokenSymbol, _fiatCurrency: FiatCurrency): Promise<Rate> {
      const rate = rateFor(token);
      if (rate === null) {
        throw new Error(`static-peg oracle: ${token} is not configured as pegged`);
      }
      return { rate, at: new Date() };
    },

    async fiatToTokenAmount(fiatAmount, token, _fiatCurrency, decimals) {
      const rate = rateFor(token);
      if (rate === null) {
        throw new Error(`static-peg oracle: ${token} is not configured as pegged`);
      }
      // Divide the fiat amount by the rate to get whole tokens, then scale to
      // raw units. Truncate dust; whole-unit precision is enough for invoicing
      // and rounding can mis-bill by a unit. Uses string arithmetic via
      // BigInt on scaled values so we don't leak floating-point error.
      const scaled = scaleDecimal(fiatAmount, decimals);
      const rateScaled = scaleDecimal(rate, decimals);
      if (rateScaled === 0n) {
        throw new Error(`static-peg oracle: zero rate for ${token}`);
      }
      const amountRaw = (scaled * BigInt(10) ** BigInt(decimals)) / rateScaled;
      return { amountRaw: amountRaw.toString(), rate };
    },

    async getUsdRates(tokens) {
      const out: Record<string, string> = {};
      for (const token of tokens) {
        const rate = rateFor(token);
        if (rate !== null) out[token] = rate;
      }
      return out;
    }
  };
}

// Parse "12.34" at `decimals` precision into a BigInt that represents the
// value × 10^decimals. Truncates excess decimals (no rounding).
function scaleDecimal(value: string, decimals: number): bigint {
  const [wholeStr, fracStr = ""] = value.split(".");
  const frac = (fracStr + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(wholeStr ?? "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0");
}
