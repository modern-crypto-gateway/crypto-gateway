import { describe, expect, it, vi } from "vitest";
import { rpcPollDetection } from "../../adapters/detection/rpc-poll.adapter.js";
import { bootTestApp } from "../helpers/boot.js";
import type { Address, ChainId } from "../../core/types/chain.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import type { ChainAdapter } from "../../core/ports/chain.port.ts";

// Minimal chain adapter that only implements scanIncoming + identity helpers.
// chainId 1 has USDC + USDT in the token registry, so the strategy's
// `tokens.length === 0` short-circuit doesn't swallow our spy.
function spyChainAdapter(spy: (args: Parameters<ChainAdapter["scanIncoming"]>[0]) => Promise<readonly DetectedTransfer[]>): ChainAdapter {
  return {
    family: "evm",
    supportedChainIds: [1 as ChainId],
    deriveAddress: () => {
      throw new Error("unused");
    },
    validateAddress: () => true,
    canonicalizeAddress: (a: string) => a as Address,
    scanIncoming: spy,
    getConfirmationStatus: async () => ({ blockNumber: null, confirmations: 0, reverted: false }),
    buildTransfer: async () => {
      throw new Error("unused");
    },
    signAndBroadcast: async () => {
      throw new Error("unused");
    },
    nativeSymbol: () => "ETH" as never,
    estimateGasForTransfer: async () => "0" as never
  };
}

describe("rpcPollDetection — minIntervalMs throttle", () => {
  it("short-circuits a second call made within the minIntervalMs window", async () => {
    const scan = vi.fn(async () => [] as readonly DetectedTransfer[]);
    const fakeNow = { t: 1_700_000_000_000 };
    const booted = await bootTestApp({
      chains: [spyChainAdapter(scan)],
      clock: { now: () => new Date(fakeNow.t) }
    });
    try {
      const strategy = rpcPollDetection({ minIntervalMs: 60_000 });
      const addresses: readonly Address[] = ["0xabc" as Address];

      // Call 1 — cold cache, no lookback checkpoint yet. Runs.
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scan).toHaveBeenCalledTimes(1);

      // Call 2, 30s later — under the 60s window. Throttled, should NOT
      // invoke scanIncoming.
      fakeNow.t += 30_000;
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scan).toHaveBeenCalledTimes(1);

      // Call 3, another 45s later (75s total) — past the window. Runs.
      fakeNow.t += 45_000;
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      await booted.close();
    }
  });

  it("never throttles when minIntervalMs is omitted (default behavior unchanged)", async () => {
    const scan = vi.fn(async () => [] as readonly DetectedTransfer[]);
    const fakeNow = { t: 1_700_000_000_000 };
    const booted = await bootTestApp({
      chains: [spyChainAdapter(scan)],
      clock: { now: () => new Date(fakeNow.t) }
    });
    try {
      const strategy = rpcPollDetection();
      const addresses: readonly Address[] = ["0xabc" as Address];

      for (let i = 0; i < 3; i++) {
        fakeNow.t += 1_000; // 1s between calls
        await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      }
      expect(scan).toHaveBeenCalledTimes(3);
    } finally {
      await booted.close();
    }
  });
});
