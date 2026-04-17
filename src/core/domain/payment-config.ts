// How many block confirmations before a transaction is considered final on
// each chain. Promotions (tx.detected -> tx.confirmed, and order.detected ->
// order.confirmed when all contributing txs are confirmed) wait for these
// thresholds. Tuned for each chain's reorg depth + finality guarantees.

export const DEFAULT_CONFIRMATION_THRESHOLDS: Readonly<Record<number, number>> = {
  1: 12,       // Ethereum mainnet
  10: 12,      // Optimism
  56: 15,      // BSC
  137: 256,    // Polygon PoS (deep reorgs historically)
  42161: 12,   // Arbitrum One
  8453: 12,    // Base
  11155111: 3, // Sepolia testnet
  999: 1       // dev chain
};

// Fallback when a chainId is not in the table above. A conservative 12 is
// safe for any EVM chain, and non-EVM adapters should set their own.
export const FALLBACK_CONFIRMATION_THRESHOLD = 12;

// `overrides` takes precedence over the shipped defaults so operators can
// tune per-chain finality without a code change — e.g. raise chain 1 to 20
// after a governance-risk event, or drop chain 137 to 64 once the Polygon
// hard fork that eliminated deep reorgs is live. Wired through AppDeps
// from an env var (`FINALITY_OVERRIDES=1:20,137:64`) in the entrypoints.
export function confirmationThreshold(
  chainId: number,
  overrides?: Readonly<Record<number, number>>
): number {
  return overrides?.[chainId] ?? DEFAULT_CONFIRMATION_THRESHOLDS[chainId] ?? FALLBACK_CONFIRMATION_THRESHOLD;
}

// Parse the `FINALITY_OVERRIDES` env format: `chainId:threshold,chainId:threshold`.
// Invalid entries are silently skipped and logged by the caller — a typo in
// one entry should not crash boot; the default threshold applies instead.
export function parseFinalityOverridesEnv(
  raw: string | undefined
): Readonly<Record<number, number>> {
  if (raw === undefined || raw.length === 0) return {};
  const out: Record<number, number> = {};
  for (const part of raw.split(",")) {
    const [chainIdStr, thresholdStr] = part.split(":").map((s) => s.trim());
    if (chainIdStr === undefined || thresholdStr === undefined) continue;
    const chainId = Number.parseInt(chainIdStr, 10);
    const threshold = Number.parseInt(thresholdStr, 10);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (!Number.isFinite(threshold) || threshold < 0) continue;
    out[chainId] = threshold;
  }
  return out;
}
