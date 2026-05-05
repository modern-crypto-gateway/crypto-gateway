import { describe, expect, it } from "vitest";
import { evmChainAdapter } from "../../../adapters/chains/evm/evm-chain.adapter.js";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../../adapters/chains/tron/tron-chain.adapter.js";
import { solanaChainAdapter } from "../../../adapters/chains/solana/solana-chain.adapter.js";
import { devChainAdapter } from "../../../adapters/chains/dev/dev-chain.adapter.js";
import type { ChainId } from "../../../core/types/chain.js";

// The picker's budget for a source = quoted fee × gasSafetyFactor. A global
// 1.5× over-reserved Tron's native balance by ~40% on every payout, which
// rejected sources that could actually afford the real quote. Per-chain
// factors fix that. These assertions pin each adapter's value so a future
// well-intentioned refactor can't silently widen any multiplier and bring
// back the over-reservation bug.

describe("ChainAdapter.gasSafetyFactor — per-chain picker multipliers", () => {
  it("EVM returns 1.5× (absorbs ~6 blocks of EIP-1559 baseFee drift)", () => {
    const adapter = evmChainAdapter({ chainIds: [1] });
    expect(adapter.gasSafetyFactor(1 as ChainId)).toEqual({ num: 150n, den: 100n });
  });

  it("Tron returns 1.30× (covers triggerConstantContract underreporting + cold-slot variance)", () => {
    // Bumped from 1.05× after production payouts proved triggerConstantContract
    // routinely underreports energy_used (~4k reported vs ~14-31k actually
    // burned for USDT). The MIN_EXPECTED_TRC20_ENERGY floor handles the worst
    // case; this multiplier covers the residual nondeterminism (cold-slot
    // transitions, SR-voted rate changes between estimate and broadcast).
    const adapter = tronChainAdapter();
    expect(adapter.gasSafetyFactor(TRON_MAINNET_CHAIN_ID as ChainId)).toEqual({
      num: 130n,
      den: 100n
    });
  });

  it("Solana returns 1.2× (fixed 5000 lamport sig fee + priority-fee headroom)", () => {
    const adapter = solanaChainAdapter();
    expect(adapter.gasSafetyFactor(101 as ChainId)).toEqual({ num: 120n, den: 100n });
  });

  it("Dev returns 1.5× (matches the pre-refactor global default)", () => {
    const adapter = devChainAdapter();
    expect(adapter.gasSafetyFactor(999 as ChainId)).toEqual({ num: 150n, den: 100n });
  });
});
