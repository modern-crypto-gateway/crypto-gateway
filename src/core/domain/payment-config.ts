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

export function confirmationThreshold(chainId: number): number {
  return DEFAULT_CONFIRMATION_THRESHOLDS[chainId] ?? FALLBACK_CONFIRMATION_THRESHOLD;
}
