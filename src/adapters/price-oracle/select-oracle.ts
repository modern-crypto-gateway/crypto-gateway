import type { CacheStore } from "../../core/ports/cache.port.ts";
import type { Logger } from "../../core/ports/logger.port.ts";
import type { PriceOracle } from "../../core/ports/price-oracle.port.ts";
import { binancePriceOracle } from "./binance.adapter.js";
import { coincapPriceOracle } from "./coincap.adapter.js";
import { coingeckoPriceOracle } from "./coingecko.adapter.js";
import { staticPegPriceOracle } from "./static-peg.adapter.js";

// Shared oracle-selection policy used by every entrypoint. Builds a fallback
// chain so a single provider outage never blocks invoice quoting.
//
// Full chain when any live source is configured:
//
//     CoinGecko → CoinCap → Binance → static-peg
//
// Each link tries itself first; on HTTP error, timeout, unmapped symbol, or
// malformed response it delegates to the next link. Only `static-peg` — the
// terminal fallback — is allowed to answer with hardcoded numbers, and only
// for the stablecoin set and the override map.
//
// Operators can narrow the chain via `PRICE_ADAPTER` (see below) when they
// want deterministic behavior (tests, dev, regulated deployments that can
// only call approved providers).
//
// Selection rules:
//   - PRICE_ADAPTER="static-peg": skip all live sources, return static-peg.
//   - PRICE_ADAPTER="coingecko" OR any COINGECKO_API_KEY / live toggle:
//     full chain (coingecko → coincap → binance → static-peg).
//   - otherwise (no flag, no key): full chain too — the free tiers of
//     CoinGecko/CoinCap/Binance don't require auth, so "no keys set" is
//     still a valid production config. Operators who want keyless static-
//     only must set PRICE_ADAPTER=static-peg explicitly.
//
// Individual fallbacks can be disabled via `DISABLE_<PROVIDER>=1` flags for
// operators who want to exclude a specific provider (e.g. a deployment
// jurisdiction that can't call Binance). Disabling collapses the chain to
// the remaining providers in the same order.

export interface SelectOracleInput {
  priceAdapter?: "alchemy" | "coingecko" | "static-peg";
  coingeckoApiKey?: string;
  coingeckoPlan?: "demo" | "pro";
  coincapApiKey?: string;
  disableCoingecko?: boolean;
  disableCoincap?: boolean;
  disableBinance?: boolean;
  cache: CacheStore;
  logger?: Logger;
}

export function selectPriceOracle(input: SelectOracleInput): PriceOracle {
  const staticPeg = staticPegPriceOracle();
  if (input.priceAdapter === "static-peg") return staticPeg;

  // Build inside-out: start from static-peg (always the last link), then
  // wrap with each enabled provider in reverse priority order so the final
  // outer layer is the highest-priority source (CoinGecko by default).
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

  if (input.disableCoingecko !== true) {
    chain = coingeckoPriceOracle({
      cache: input.cache,
      fallback: chain,
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
      ...(input.coingeckoApiKey !== undefined ? { apiKey: input.coingeckoApiKey } : {}),
      ...(input.coingeckoPlan !== undefined ? { plan: input.coingeckoPlan } : {})
    });
  }

  return chain;
}
