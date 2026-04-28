import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import { alchemyPriceOracle } from "./alchemy.adapter.js";
import { binancePriceOracle } from "./binance.adapter.js";
import { coincapPriceOracle } from "./coincap.adapter.js";
import { coingeckoPriceOracle } from "./coingecko.adapter.js";
import { noopPriceOracle } from "./noop.adapter.js";
import { staticPegPriceOracle } from "./static-peg.adapter.js";

// Shared oracle-selection policy used by every entrypoint. Builds a fallback
// chain so a single provider outage never blocks invoice quoting.
//
// Full chain when every live source is configured (CoinGecko-first default):
//
//     CoinGecko → Alchemy → CoinCap → Binance → noop
//
// When PRICE_ADAPTER=alchemy is set (and an ALCHEMY_API_KEY is available),
// Alchemy swaps to the front of the chain:
//
//     Alchemy → CoinGecko → CoinCap → Binance → noop
//
// Each link tries itself first; on HTTP error, timeout, unmapped symbol, or
// malformed response it delegates to the next link. The terminal `noop`
// throws OracleUnavailableError for tokenToFiat / fiatToTokenAmount and
// returns `{}` for getUsdRates — production never silently substitutes
// hardcoded numbers for a live rate. Mis-priced invoices (off by tens of
// percent against a stale hardcoded peg) cause real financial loss, so
// the gateway prefers an explicit failure. The cron's warmRateCache
// preserves the last-good cache entry across short outages so this
// failure is rare in practice.
//
// Selection rules:
//   - PRICE_ADAPTER="static-peg": explicit opt-in — return static-peg as
//     the only oracle. Intended for tests and dev. NOT recommended for
//     production: rates are hardcoded mid-range values that can be off
//     by 30–50 % against the live market.
//   - PRICE_ADAPTER="alchemy": Alchemy becomes the outermost link if a key
//     is set; if no key is available we log and fall through to the default
//     CoinGecko-first ordering.
//   - PRICE_ADAPTER="coingecko" (or unset): CoinGecko-first default chain.
//   - No API keys set at all is still a valid production config because the
//     CoinGecko/CoinCap/Binance free tiers are keyless.
//
// Individual fallbacks can be disabled via `DISABLE_<PROVIDER>=1` flags for
// operators who want to exclude a specific provider (e.g. a deployment
// jurisdiction that can't call Binance, or an Alchemy plan that doesn't
// include Prices API credits). Disabling collapses the chain to the
// remaining providers in the same order.

export interface SelectOracleInput {
  priceAdapter?: "alchemy" | "coingecko" | "static-peg";
  coingeckoApiKey?: string;
  coingeckoPlan?: "demo" | "pro";
  coincapApiKey?: string;
  alchemyApiKey?: string;
  disableCoingecko?: boolean;
  disableCoincap?: boolean;
  disableBinance?: boolean;
  disableAlchemy?: boolean;
  cache: CacheStore;
  logger?: Logger;
}

export function selectPriceOracle(input: SelectOracleInput): PriceOracle {
  // Explicit opt-in for the static-peg oracle. Tests and dev use this
  // directly via `staticPegPriceOracle()` without going through select-
  // oracle; this branch is here for operators who want to force keyless
  // hardcoded behavior in production-like environments. Otherwise the
  // production chain ends with `noop`, which fails explicitly rather
  // than silently substituting hardcoded numbers.
  if (input.priceAdapter === "static-peg") return staticPegPriceOracle();

  const alchemyEnabled = input.disableAlchemy !== true && input.alchemyApiKey !== undefined;
  const alchemyFirst = input.priceAdapter === "alchemy";
  if (input.priceAdapter === "alchemy" && input.alchemyApiKey === undefined) {
    input.logger?.warn(
      "PRICE_ADAPTER=alchemy requested but ALCHEMY_API_KEY is not set; using default CoinGecko-first chain"
    );
  }

  // Build inside-out: start from `noop` (terminal — empty rates +
  // explicit error), then wrap with each enabled provider in reverse
  // priority order so the final outer layer is the highest-priority
  // source. No static-peg in production — see file header for rationale.
  let chain: PriceOracle = noopPriceOracle();

  if (input.disableBinance !== true) {
    chain = binancePriceOracle({
      cache: input.cache,
      fallback: chain,
      ...(input.logger !== undefined ? { logger: input.logger } : {})
    });
  }

  if (input.disableCoincap !== true) {
    chain = coincapPriceOracle({
      cache: input.cache,
      fallback: chain,
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
      ...(input.coincapApiKey !== undefined ? { apiKey: input.coincapApiKey } : {})
    });
  }

  // Alchemy default position: between CoinGecko and CoinCap. When
  // PRICE_ADAPTER=alchemy we skip adding it here and wrap it at the very
  // end so it becomes the outermost layer (ahead of CoinGecko).
  if (alchemyEnabled && !alchemyFirst) {
    chain = alchemyPriceOracle({
      cache: input.cache,
      fallback: chain,
      apiKey: input.alchemyApiKey!,
      ...(input.logger !== undefined ? { logger: input.logger } : {})
    });
  }

  if (input.disableCoingecko !== true) {
    chain = coingeckoPriceOracle({
      cache: input.cache,
      fallback: chain,
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
      ...(input.coingeckoApiKey !== undefined ? { apiKey: input.coingeckoApiKey } : {}),
      ...(input.coingeckoPlan !== undefined ? { plan: input.coingeckoPlan } : {})
    });
  }

  if (alchemyEnabled && alchemyFirst) {
    chain = alchemyPriceOracle({
      cache: input.cache,
      fallback: chain,
      apiKey: input.alchemyApiKey!,
      ...(input.logger !== undefined ? { logger: input.logger } : {})
    });
  }

  return chain;
}
