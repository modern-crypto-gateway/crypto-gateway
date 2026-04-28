import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import type { FiatCurrency, Rate } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

// Terminal "no live source available" oracle.
//
// Sits at the end of the production fallback chain (CoinGecko → Alchemy →
// CoinCap → Binance → noop). Each preceding adapter falls through to this
// when it can't quote; the noop's job is to surface the failure cleanly
// rather than silently substituting hardcoded values.
//
// Behavior:
//   - `getUsdRates`: returns `{}`. The caller (cron warmRateCache) merges
//     this with whatever upstream produced — empty here means "this token
//     is unknown to every wired oracle". invoice-create then sees a missing
//     entry in its cache lookup and surfaces RATE_NOT_FOUND_FOR_TOKEN.
//   - `tokenToFiat` / `fiatToTokenAmount`: throw OracleUnavailableError so
//     the legacy fiat-amount invoice creation path fails explicitly when
//     no oracle can quote — the merchant sees a 503 + a clear retry hint.
//
// This replaces the prior `static-peg` terminal, which always returned a
// hardcoded number and produced silent mis-pricing on oracle outages.
// Static-peg is still available for tests and explicit `PRICE_ADAPTER=
// static-peg` opt-in; it just isn't part of the production chain.

export class OracleUnavailableError extends Error {
  constructor() {
    super(
      "All configured price oracles are unavailable. Retry shortly; if persistent, check oracle health and provider quotas."
    );
    this.name = "OracleUnavailableError";
  }
}

export function noopPriceOracle(): PriceOracle {
  return {
    async tokenToFiat(_token: TokenSymbol, _fiatCurrency: FiatCurrency): Promise<Rate> {
      throw new OracleUnavailableError();
    },
    async fiatToTokenAmount() {
      throw new OracleUnavailableError();
    },
    async getUsdRates() {
      return {};
    }
  };
}
