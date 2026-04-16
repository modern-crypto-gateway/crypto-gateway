import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import type { FiatCurrency, Rate } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

// Returns a 1:1 peg for stables. The cheapest possible PriceOracle — no network,
// no cache, no provider key. Used for local dev, tests, and deployments that
// only accept USD-pegged stablecoins (USDC, USDT, DAI, ...).
// For volatile tokens, pair with alchemy-prices or coingecko in Phase 4.

export interface StaticPegConfig {
  // Which symbols are considered 1:1. Defaults to the common USD stables.
  peggedSymbols?: readonly TokenSymbol[];
}

export function staticPegPriceOracle(config: StaticPegConfig = {}): PriceOracle {
  const pegged = new Set<string>(config.peggedSymbols ?? (["USDC", "USDT", "DAI", "DEV"] as TokenSymbol[]));

  return {
    async tokenToFiat(token: TokenSymbol, _fiatCurrency: FiatCurrency): Promise<Rate> {
      if (!pegged.has(token)) {
        throw new Error(`static-peg oracle: ${token} is not configured as pegged`);
      }
      return { rate: "1", at: new Date() };
    },

    async fiatToTokenAmount(fiatAmount, token, _fiatCurrency, decimals) {
      if (!pegged.has(token)) {
        throw new Error(`static-peg oracle: ${token} is not configured as pegged`);
      }
      // Parse "12.34" into raw token units at `decimals`, truncating (not rounding)
      // any sub-unit dust. Whole-unit precision is all that matters for invoicing;
      // rounding can mis-bill by a unit.
      const [wholeStr, fracStr = ""] = fiatAmount.split(".");
      const frac = (fracStr + "0".repeat(decimals)).slice(0, decimals);
      const amountRaw = `${BigInt(wholeStr ?? "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0")}`;
      return { amountRaw, rate: "1" };
    }
  };
}
