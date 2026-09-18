import { describe, expect, it } from "vitest";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../../../adapters/chains/tron/tron-chain.adapter.js";
import { evmChainAdapter } from "../../../../adapters/chains/evm/evm-chain.adapter.js";
import type { ChainId } from "../../../../core/types/chain.js";

// Tron has no chain-level rent/reserve rule, but the adapter reports a
// 1 TRX operator-policy keeper. The payout picker adds it to every source /
// sponsor budget and the consolidation planner subtracts it from each
// source's sweepable amount, so no pool address is ever fully drained.
// Pinned here so a refactor that "corrects" it back to 0n fails loudly.
describe("Tron minimumNativeReserve — 1 TRX policy keeper", () => {
  it("returns exactly 1 TRX (1e6 SUN) on mainnet", () => {
    const adapter = tronChainAdapter();
    expect(adapter.minimumNativeReserve(TRON_MAINNET_CHAIN_ID as ChainId)).toBe(1_000_000n);
  });

  it("returns the same keeper for any Tron chainId (Nile / Shasta)", () => {
    const adapter = tronChainAdapter();
    expect(adapter.minimumNativeReserve(3448148188 as ChainId)).toBe(1_000_000n);
    expect(adapter.minimumNativeReserve(2494104990 as ChainId)).toBe(1_000_000n);
  });

  it("EVM still returns 0 — the keeper is Tron-only policy", () => {
    const adapter = evmChainAdapter({ chainIds: [1] });
    expect(adapter.minimumNativeReserve(1 as ChainId)).toBe(0n);
  });
});
