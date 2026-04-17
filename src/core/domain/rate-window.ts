import type { AppDeps } from "../app-deps.js";
import type { ChainFamily } from "../types/chain.js";
import { TOKEN_REGISTRY } from "../types/token-registry.js";
import type { TokenSymbol } from "../types/token.js";

// 10-minute rolling rate window for USD-path orders.
//
// On order creation we snapshot USD rates for every token the order can
// accept (every registered symbol in every accepted family, deduped) and
// pin them for 10 minutes. Subsequent payments within that window convert
// at the pinned rates. When detection happens past expiry, we refresh.
//
// This is the "simple with mix" stance from the product debate: merchant
// bears limited risk (locked-in rate for the current 10-minute slice),
// customer gets predictable pricing, volatility-induced short-paid orders
// are caught in the NEXT window rather than silently.

export const RATE_WINDOW_DURATION_MS = 10 * 60 * 1000;

export interface RateSnapshot {
  // Decimal-string USD per 1 whole token: { "USDC": "1.00", "ETH": "2500.00" }.
  rates: Readonly<Record<string, string>>;
  // Unix-ms timestamp this window expires at (window created AT / closed AT).
  expiresAt: number;
}

// Enumerate every distinct token symbol registered on any chain in the
// supplied families. Input to oracle.getUsdRates — determines the set of
// tokens whose rates we pin for this order.
export function tokensForFamilies(families: readonly ChainFamily[]): readonly TokenSymbol[] {
  const set = new Set<string>();
  for (const entry of TOKEN_REGISTRY) {
    const family = familyForChainId(entry.chainId);
    if (family === null) continue;
    if (!families.includes(family)) continue;
    set.add(entry.symbol);
    // Also include the native symbol per family. Native tokens usually
    // aren't in the token registry (they have no contract address), so
    // we add them explicitly below.
  }
  // Add family native tokens the oracle should quote. Registry has these
  // for Solana + dev chain via `contractAddress: null`; other families'
  // natives (ETH, BNB, MATIC, AVAX, TRX) aren't currently in the registry
  // but may arrive as transfers, so the oracle needs to quote them.
  if (families.includes("evm")) {
    set.add("ETH");
    set.add("BNB");
    set.add("MATIC");
    set.add("AVAX");
  }
  if (families.includes("tron")) {
    set.add("TRX");
  }
  if (families.includes("solana")) {
    set.add("SOL");
  }
  return Array.from(set) as TokenSymbol[];
}

// Snapshot the current rates for `tokens`. Used at order creation and at
// rate-window refresh. Missing rates (oracle doesn't recognize the token)
// are omitted — detection of a payment in an unpriced token will fall
// back gracefully to "ignore" rather than crash the ingest path.
export async function snapshotRates(
  deps: AppDeps,
  tokens: readonly TokenSymbol[]
): Promise<RateSnapshot> {
  const now = deps.clock.now().getTime();
  const rates = await deps.priceOracle.getUsdRates(tokens);
  return {
    rates,
    expiresAt: now + RATE_WINDOW_DURATION_MS
  };
}

// Local copy of familyForChainId (order.service has one too — keeping a
// dependency-free helper here avoids cycles). Both must agree.
function familyForChainId(chainId: number): ChainFamily | null {
  if (chainId >= 900 && chainId <= 901) return "solana";
  if (chainId === 728126428 || chainId === 3448148188) return "tron";
  if (chainId === 999) return "evm"; // dev chain
  if (chainId > 0) return "evm"; // every real EVM chain id we support is > 0
  return null;
}
