import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import { alchemyPriceOracle } from "./alchemy.adapter.js";
import { binancePriceOracle } from "./binance.adapter.js";
import { coincapPriceOracle } from "./coincap.adapter.js";
import { coingeckoPriceOracle } from "./coingecko.adapter.js";
import { staticPegPriceOracle } from "./static-peg.adapter.js";

// Shared oracle-selection policy used by every entrypoint. Builds a fallback
// chain so a single provider outage never blocks invoice quoting.
//
// Full chain when every live source is configured (CoinGecko-first default):
//
//     CoinGecko → Alchemy → CoinCap → Binance → static-peg
//
// When PRICE_ADAPTER=alchemy is set (and an ALCHEMY_API_KEY is available),
// Alchemy swaps to the front of the chain:
//
//     Alchemy → CoinGecko → CoinCap → Binance → static-peg
//
// Each link tries itself first; on HTTP error, timeout, unmapped symbol, or
// malformed response it delegates to the next link. Only `static-peg` — the
// terminal fallback — is allowed to answer with hardcoded numbers, and only
// for the stablecoin set and the override map.
//
// Selection rules:
//   - PRICE_ADAPTER="static-peg": skip every live source, return static-peg.
//   - PRICE_ADAPTER="alchemy": Alchemy becomes the outermost link if a key
//     is set; if no key is available we log and fall through to the default
//     CoinGecko-first ordering rather than silently degrading to static-peg.
//   - PRICE_ADAPTER="coingecko" (or unset): CoinGecko-first default chain.
//   - No API keys set at all is still a valid production config because the
//     CoinGecko/CoinCap/Binance free tiers are keyless. Set PRICE_ADAPTER=
//     static-peg explicitly to force keyless-static-only behavior.
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
  const staticPeg = staticPegPriceOracle();
  if (input.priceAdapter === "static-peg") return staticPeg;

  const alchemyEnabled = input.disableAlchemy !== true && input.alchemyApiKey !== undefined;
  const alchemyFirst = input.priceAdapter === "alchemy";
  if (input.priceAdapter === "alchemy" && input.alchemyApiKey === undefined) {
    input.logger?.warn(
      "PRICE_ADAPTER=alchemy requested but ALCHEMY_API_KEY is not set; using default CoinGecko-first chain"
    );
  }

  // Build inside-out: start from static-peg (always the last link), then wrap
  // with each enabled provider in reverse priority order so the final outer
  // layer is the highest-priority source.
  let chain: PriceOracle = staticPeg;

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
