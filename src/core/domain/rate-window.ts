import type { AppDeps } from "../app-deps.js";
import type { ChainFamily } from "../types/chain.js";
import { findToken, TOKEN_REGISTRY } from "../types/token-registry.js";
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

// If the order's rate window has expired, re-query the oracle and persist a
// fresh snapshot on the order row. Returns the rates that SHOULD be used for
// the current detection event. Safe to call on every ingest: when the window
// is still valid, this is a single in-memory check + DB read (no network).
//
// Concurrent detections for the same order race here; we accept a small
// chance of two simultaneous refreshes producing slightly different rates.
// The last write wins and both writes see consistent subsequent payments.
// For sub-second precision, callers would need a per-order lock — overkill
// for a 10-minute window where a 100ms race is invisible.
export async function refreshIfExpired(
  deps: AppDeps,
  orderId: string,
  currentRates: Readonly<Record<string, string>> | null,
  currentExpiresAt: number | null,
  acceptedFamilies: readonly ChainFamily[]
): Promise<Readonly<Record<string, string>>> {
  const now = deps.clock.now().getTime();
  if (currentRates !== null && currentExpiresAt !== null && now < currentExpiresAt) {
    return currentRates;
  }
  const snapshot = await snapshotRates(deps, tokensForFamilies(acceptedFamilies));
  await deps.db
    .prepare(
      "UPDATE orders SET rates_json = ?, rate_window_expires_at = ?, updated_at = ? WHERE id = ?"
    )
    .bind(JSON.stringify(snapshot.rates), snapshot.expiresAt, now, orderId)
    .run();
  return snapshot.rates;
}

// Decimals lookup for a (chainId, token) pair. Registry is the source of
// truth for contract-backed tokens (USDC / USDT); hardcoded natives fill
// the gap so ETH / BNB / AVAX / MATIC / SOL / TRX transfers can be USD-
// valued without per-chain adapter queries. Returns null for unknown tokens
// — detection skips the USD aggregation for those (the payment still lands
// in `transactions` for audit).
export function tokenDecimalsFor(chainId: number, token: string): number | null {
  const registered = findToken(chainId, token as TokenSymbol);
  if (registered) return registered.decimals;
  const family = familyForChainId(chainId);
  if (family === "evm") {
    if (token === "ETH" || token === "BNB" || token === "MATIC" || token === "AVAX" || token === "POL") {
      return 18;
    }
  }
  if (family === "solana" && token === "SOL") return 9;
  if (family === "tron" && token === "TRX") return 6;
  return null;
}

// Compute the USD value of a raw-unit transfer, using a pinned rate. Returns
// null when the token isn't priceable — caller writes amount_usd = NULL on
// the transaction row and the order's paid_usd total skips it (the payment
// still counts toward received_amount_raw for legacy orders, just not USD).
//
// Math: usd = amount_raw / 10^decimals * rate. Done with BigInt to avoid
// floating-point drift; result is a string to two decimal places (standard
// USD precision; downstream totals use BigInt cents internally).
export function usdValueFor(
  amountRaw: string,
  token: string,
  chainId: number,
  rates: Readonly<Record<string, string>>
): string | null {
  const decimals = tokenDecimalsFor(chainId, token);
  if (decimals === null) return null;
  const rate = rates[token];
  if (rate === undefined) return null;

  // Work in "cents" (×100 USD) via BigInt so we never touch Number for an
  // amount that might dwarf MAX_SAFE_INTEGER. rate is decimal-string, so
  // scale it up by 10^8 for 8 decimals of rate precision, then back down.
  const RATE_SCALE = 8;
  const rateCents = scaleDecimal(rate, RATE_SCALE);
  // amountRaw is scaled by 10^decimals; multiply by rate (scaled by RATE_SCALE)
  // and divide by 10^(decimals + RATE_SCALE) to get whole dollars. Then ×100
  // for cents.
  const numerator = BigInt(amountRaw) * rateCents * 100n;
  const divisor = BigInt(10) ** BigInt(decimals + RATE_SCALE);
  const cents = numerator / divisor;
  const dollars = cents / 100n;
  const centRemainder = cents % 100n;
  return `${dollars}.${centRemainder.toString().padStart(2, "0")}`;
}

function scaleDecimal(value: string, decimals: number): bigint {
  const [wholeStr, fracStr = ""] = value.split(".");
  const frac = (fracStr + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(wholeStr ?? "0") * BigInt(10) ** BigInt(decimals) + BigInt(frac || "0");
}

// Add two decimal-string USD amounts. Used by the order's paid_usd
// aggregate to avoid floating-point drift across many small partial
// payments. Returns "D.CC" (cents precision).
export function addUsd(a: string, b: string): string {
  const sum = scaleDecimal(a, 2) + scaleDecimal(b, 2);
  const dollars = sum / 100n;
  const cents = sum % 100n;
  return `${dollars}.${cents.toString().padStart(2, "0")}`;
}

// Compare two decimal-string USD amounts. Returns 1 when a > b, -1 when
// a < b, 0 otherwise. Used by status transitions (is paid_usd ≥ amount_usd?).
export function compareUsd(a: string, b: string): number {
  const av = scaleDecimal(a, 2);
  const bv = scaleDecimal(b, 2);
  if (av > bv) return 1;
  if (av < bv) return -1;
  return 0;
}

// a - b in USD. Negative results clamp to "0.00" — caller uses this for
// overpaid deltas, where negative would be nonsense.
export function subUsd(a: string, b: string): string {
  const diff = scaleDecimal(a, 2) - scaleDecimal(b, 2);
  if (diff <= 0n) return "0.00";
  const dollars = diff / 100n;
  const cents = diff % 100n;
  return `${dollars}.${cents.toString().padStart(2, "0")}`;
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
