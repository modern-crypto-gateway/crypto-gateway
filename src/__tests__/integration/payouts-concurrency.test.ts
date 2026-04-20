import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { feeWallets, payouts } from "../../db/schema.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  executeReservedPayouts,
  planPayout,
  registerFeeWallet
} from "../../core/domain/payout.service.js";
import { feeWalletIndex } from "../../adapters/signer-store/hd.adapter.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import type { ChainAdapter } from "../../core/ports/chain.port.ts";
import type { TxHash } from "../../core/types/chain.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Wrap the dev adapter so signAndBroadcast sleeps and tracks concurrency.
// Without the latency, every payout would complete inside one tick of the
// event loop and "concurrency" would be invisible to the assertion.
function instrumentedDevAdapter(latencyMs: number): {
  adapter: ChainAdapter;
  peakConcurrent: () => number;
  totalBroadcasts: () => number;
  uniqueHashes: () => number;
} {
  const base = devChainAdapter({ deterministicTxHashes: false });
  let inflight = 0;
  let peak = 0;
  const seenHashes = new Set<string>();
  const wrapped: ChainAdapter = {
    ...base,
    async signAndBroadcast(unsigned, key) {
      inflight += 1;
      if (inflight > peak) peak = inflight;
      try {
        await new Promise((r) => setTimeout(r, latencyMs));
        const hash = await base.signAndBroadcast(unsigned, key);
        seenHashes.add(hash as string);
        return hash;
      } finally {
        inflight -= 1;
      }
    }
  };
  return {
    adapter: wrapped,
    peakConcurrent: () => peak,
    totalBroadcasts: () => seenHashes.size,
    uniqueHashes: () => seenHashes.size
  };
}

async function seedFeeWallet(
  booted: BootedTestApp,
  args: { label: string }
): Promise<{ address: string }> {
  const adapter = booted.deps.chains.find((c) => c.family === "evm");
  if (!adapter) throw new Error("seedFeeWallet: no EVM adapter");
  const index = feeWalletIndex("evm", args.label);
  const { address } = adapter.deriveAddress(TEST_MASTER_SEED, index);
  const canonical = adapter.canonicalizeAddress(address);
  await registerFeeWallet(booted.deps, {
    chainId: 999,
    address: canonical,
    label: args.label,
    derivationIndex: index
  });
  return { address: canonical };
}

async function planN(booted: BootedTestApp, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
  }
}

describe("executeReservedPayouts — bounded-concurrency runner", () => {
  let booted: BootedTestApp;
  let probe: ReturnType<typeof instrumentedDevAdapter>;

  afterEach(async () => {
    if (booted) await booted.close();
  });

  it("processes payouts on one chain in parallel up to the per-chain cap", async () => {
    probe = instrumentedDevAdapter(40);
    booted = await bootTestApp({
      chains: [probe.adapter],
      // Cap at 4 — with 8 wallets + 8 payouts we expect peak == 4.
      // Field is read by executeReservedPayouts via `deps.payoutConcurrencyPerChain`.
    });
    // Patch the cap directly on the deps object since bootTestApp doesn't
    // expose this option yet — keeps the helper unchanged for unrelated tests.
    (booted.deps as unknown as { payoutConcurrencyPerChain: number }).payoutConcurrencyPerChain = 4;

    for (let i = 1; i <= 8; i++) {
      await seedFeeWallet(booted, { label: `hot-${i}` });
    }
    await planN(booted, 8);

    const result = await executeReservedPayouts(booted.deps);

    expect(result.attempted).toBe(8);
    expect(result.submitted).toBe(8);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(0);
    // The whole point of this PR: the cap is honored, AND we actually run
    // more than one at a time (otherwise concurrency lift was a no-op).
    expect(probe.peakConcurrent()).toBeGreaterThan(1);
    expect(probe.peakConcurrent()).toBeLessThanOrEqual(4);
    // No double-broadcast: every payout produces a unique tx hash.
    expect(probe.uniqueHashes()).toBe(8);
  });

  it("falls back to serial-equivalent when cap is 1", async () => {
    probe = instrumentedDevAdapter(20);
    booted = await bootTestApp({ chains: [probe.adapter] });
    (booted.deps as unknown as { payoutConcurrencyPerChain: number }).payoutConcurrencyPerChain = 1;

    for (let i = 1; i <= 4; i++) {
      await seedFeeWallet(booted, { label: `hot-${i}` });
    }
    await planN(booted, 4);

    const result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(4);
    expect(probe.peakConcurrent()).toBe(1);
  });

  it("with fewer wallets than payouts, CAS contention defers the extras (no double-claim)", async () => {
    probe = instrumentedDevAdapter(30);
    booted = await bootTestApp({ chains: [probe.adapter] });
    (booted.deps as unknown as { payoutConcurrencyPerChain: number }).payoutConcurrencyPerChain = 8;

    // 2 wallets, 6 payouts. Each wallet can serve one payout per tick. The
    // remaining 4 should land in `deferred` — never reserved twice.
    await seedFeeWallet(booted, { label: "hot-1" });
    await seedFeeWallet(booted, { label: "hot-2" });
    await planN(booted, 6);

    const result = await executeReservedPayouts(booted.deps);

    expect(result.attempted).toBe(6);
    expect(result.submitted).toBe(2);
    expect(result.deferred).toBe(4);
    expect(result.failed).toBe(0);

    // Verify on disk: exactly 2 submitted, 4 still planned.
    const rows = await booted.deps.db
      .select({ status: payouts.status })
      .from(payouts);
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ submitted: 2, planned: 4 });

    // Each wallet is held by exactly one in-flight `submitted` payout (the
    // broadcast slot CAS prevents double-reservation). Wallets release only
    // after confirmPayouts runs — that's a separate cron step. Here we just
    // confirm that no wallet is double-claimed.
    const walletRows = await booted.deps.db
      .select({ reservedBy: feeWallets.reservedByPayoutId })
      .from(feeWallets)
      .where(eq(feeWallets.chainId, 999));
    const reservedIds = walletRows
      .map((w) => w.reservedBy)
      .filter((v): v is string => v !== null);
    expect(reservedIds).toHaveLength(2);
    expect(new Set(reservedIds).size).toBe(2); // distinct payouts
  });

  it("default cap (16) is applied when deps.payoutConcurrencyPerChain is unset", async () => {
    probe = instrumentedDevAdapter(15);
    booted = await bootTestApp({ chains: [probe.adapter] });
    // Don't set payoutConcurrencyPerChain — fall back to default.

    for (let i = 1; i <= 20; i++) {
      await seedFeeWallet(booted, { label: `hot-${i}` });
    }
    await planN(booted, 20);

    const result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(20);
    expect(probe.peakConcurrent()).toBeGreaterThan(1);
    expect(probe.peakConcurrent()).toBeLessThanOrEqual(16);

    // Sanity: every produced tx hash is distinct (no double-broadcast under
    // default-cap parallelism either).
    const txHashRows = await booted.deps.db
      .select({ tx: payouts.txHash })
      .from(payouts)
      .where(eq(payouts.status, "submitted"));
    const distinct = new Set(txHashRows.map((r) => r.tx as TxHash));
    expect(distinct.size).toBe(20);
  });
});
