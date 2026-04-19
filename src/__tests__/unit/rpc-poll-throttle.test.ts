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
    estimateGasForTransfer: async () => "0" as never,
    getBalance: async () => "0" as never,
    getAccountBalances: async () => []
  };
}

describe("rpcPollDetection — minIntervalMs throttle", () => {
  it("short-circuits a second call made within the minIntervalMs window", async () => {
    const scan = vi.fn(async () => [] as readonly DetectedTransfer[]);
    const fakeNow = { t: 1_700_000_000_000 };
    const booted = await bootTestApp({
      chains: [spyChainAdapter(scan)],
      clock: { now: () => new Date(fakeNow.t) },
      // Stub chain adapter's deriveAddress throws; skip pool seeding so
      // bootTestApp's top-up pass doesn't trip on the stub.
      skipPoolInit: true
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
      clock: { now: () => new Date(fakeNow.t) },
      // Stub chain adapter's deriveAddress throws; skip pool seeding so
      // bootTestApp's top-up pass doesn't trip on the stub.
      skipPoolInit: true
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

describe("rpcPollDetection — checkpointGraceMs (provider indexing lag)", () => {
  it("extends each scan's sinceMs backwards by the grace window so a late-indexed tx isn't permanently missed", async () => {
    const scanCalls: number[] = [];
    const scan = vi.fn(async (args: Parameters<ChainAdapter["scanIncoming"]>[0]) => {
      scanCalls.push(args.sinceMs);
      return [] as readonly DetectedTransfer[];
    });
    const fakeNow = { t: 1_700_000_000_000 };
    const booted = await bootTestApp({
      chains: [spyChainAdapter(scan)],
      clock: { now: () => new Date(fakeNow.t) },
      skipPoolInit: true
    });
    try {
      const strategy = rpcPollDetection({ checkpointGraceMs: 2 * 60_000 });
      const addresses: readonly Address[] = ["0xabc" as Address];

      // Call 1 — cold cache. sinceMs falls back to now - defaultLookbackMs.
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scanCalls).toHaveLength(1);
      expect(scanCalls[0]).toBe(fakeNow.t - 5 * 60_000);
      const cp1 = fakeNow.t;

      // Call 2 — 3 min later. Checkpoint was cp1; sinceMs = cp1 - 2min grace.
      // Without grace, sinceMs would be cp1 exactly and a tx with
      // block_timestamp in (cp1 - 60s, cp1) that wasn't yet indexed at cp1
      // would fall outside [cp1, now] forever.
      fakeNow.t += 3 * 60_000;
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scanCalls).toHaveLength(2);
      expect(scanCalls[1]).toBe(cp1 - 2 * 60_000);
    } finally {
      await booted.close();
    }
  });

  it("throttle compares against the unmodified last-poll wall-clock time (grace does not shrink minIntervalMs)", async () => {
    const scan = vi.fn(async () => [] as readonly DetectedTransfer[]);
    const fakeNow = { t: 1_700_000_000_000 };
    const booted = await bootTestApp({
      chains: [spyChainAdapter(scan)],
      clock: { now: () => new Date(fakeNow.t) },
      skipPoolInit: true
    });
    try {
      const strategy = rpcPollDetection({
        minIntervalMs: 60_000,
        checkpointGraceMs: 2 * 60_000
      });
      const addresses: readonly Address[] = ["0xabc" as Address];

      // Call 1 — cold. Runs.
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scan).toHaveBeenCalledTimes(1);

      // Call 2, 30s later — still inside 60s throttle window. If the throttle
      // accidentally compared `now - (checkpoint - grace)`, this would read
      // as 2min 30s and the call would escape the throttle. It must stay
      // throttled regardless of grace value.
      fakeNow.t += 30_000;
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scan).toHaveBeenCalledTimes(1);

      // Call 3, 40s later (70s total) — past throttle. Runs.
      fakeNow.t += 40_000;
      await strategy.poll!(booted.deps, 1 as ChainId, addresses);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      await booted.close();
    }
  });
});
