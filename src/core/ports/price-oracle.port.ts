import type { FiatCurrency, Rate } from "../types/money.js";
import type { TokenSymbol } from "../types/token.js";

// Abstracts token-to-fiat pricing. Implementations: alchemy-prices, coingecko,
// static-peg (returns 1:1 for stables without a network call — the default in
// local/dev). The domain never calls a specific provider; it asks the oracle.

export interface PriceOracle {
  // Spot rate for 1 whole `token` in `fiatCurrency`. e.g. USDC/USD ≈ 1.0003.
  // Implementations are expected to cache internally (CacheStore or their own store).
  tokenToFiat(token: TokenSymbol, fiatCurrency: FiatCurrency): Promise<Rate>;

  // Converts a fiat amount into raw token units at current rate. Returns the
  // rate used so callers can persist it alongside the order (auditability).
  fiatToTokenAmount(
    fiatAmount: string,
    token: TokenSymbol,
    fiatCurrency: FiatCurrency,
    decimals: number
  ): Promise<{ amountRaw: string; rate: string }>;

  // Batch USD-rate lookup used by the rate-window snapshot. Returns a map
  // keyed by the requested token symbols. Tokens the oracle doesn't
  // recognize are omitted — callers should treat them as "not priced"
  // rather than substituting a default. Values are decimal strings of USD
  // per 1 whole token (so 1 USDC ≈ "1.00", 1 ETH ≈ "2500.00").
  getUsdRates(tokens: readonly TokenSymbol[]): Promise<Readonly<Record<string, string>>>;
}
