import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { payouts } from "../../db/schema.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  executeReservedPayouts,
  planPayout,
  registerFeeWallet
} from "../../core/domain/payout.service.js";
import { feeWalletIndex } from "../../adapters/signer-store/hd.adapter.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import type { ChainAdapter } from "../../core/ports/chain.port.ts";
import type { AmountRaw } from "../../core/types/money.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";
const GOOD_DEST = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Dev adapter wrapper that looks up each wallet's balance from a map, so
// tests can stage "wallet X has $50, wallet Y has $5" without any real RPC.
function programmable(
  balances: Map<string, bigint>
): { adapter: ChainAdapter } {
  const base = devChainAdapter({ deterministicTxHashes: false });
  const wrapped: ChainAdapter = {
    ...base,
    async getBalance(args) {
      const v = balances.get(args.address.toLowerCase());
      return (v ?? 0n).toString() as AmountRaw;
    },
    // Dev adapter's default gas (21000) is larger than the tiny balances in
    // these tests, which would wrongly filter out wallets via the native-gas
    // check. Return 0 so these tests focus on the token-balance math.
    async estimateGasForTransfer() {
      return "0" as AmountRaw;
    }
  };
  return { adapter: wrapped };
}

async function seed(
  booted: BootedTestApp,
  label: string
): Promise<{ address: string }> {
  const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
  const index = feeWalletIndex("evm", label);
  const { address } = adapter.deriveAddress(TEST_MASTER_SEED, index);
  const canonical = adapter.canonicalizeAddress(address);
  await registerFeeWallet(booted.deps, {
    chainId: 999,
    address: canonical,
    label,
    derivationIndex: index
  });
  return { address: canonical };
}

describe("executeReservedPayouts — multi-source fallback", () => {
  let booted: BootedTestApp;

  afterEach(async () => {
    if (booted) await booted.close();
  });

  it("splits a payout across multiple wallets when allowMultiSource=true and no single wallet has enough", async () => {
    const balances = new Map<string, bigint>();
    const { adapter } = programmable(balances);
    booted = await bootTestApp({ chains: [adapter] });

    // Seed 4 wallets. No single one has enough to cover 1000, but together
    // 990+5+4+1 = 1000 exactly. Aggregate order (by balance DESC) is what
    // the multi-source selector greedy-picks.
    const big = await seed(booted, "big");
    const small = await seed(booted, "small");
    const tiny = await seed(booted, "tiny");
    const xs = await seed(booted, "xs");
    balances.set(big.address, 990n);
    balances.set(small.address, 5n);
    balances.set(tiny.address, 4n);
    balances.set(xs.address, 1n);

    const payout = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1000",
      destinationAddress: GOOD_DEST,
      allowMultiSource: true
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(0);

    const [row] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, payout.id))
      .limit(1);
    expect(row?.status).toBe("submitted");
    expect(row?.txHashesJson).not.toBeNull();
    expect(row?.sourceAddressesJson).not.toBeNull();
    const hashes = JSON.parse(row!.txHashesJson!);
    const sources = JSON.parse(row!.sourceAddressesJson!);
    // Greedy fill: 990 from big (1000 - 990 = 10 remaining), 5 from small
    // (5 remaining), 4 from tiny (1 remaining), 1 from xs (0) → 4 legs.
    expect(hashes).toHaveLength(4);
    expect(sources).toHaveLength(4);
    // The first leg's source is the biggest-balance wallet (greedy desc order).
    expect(sources[0]).toBe(big.address);
    // Every hash is unique — no accidental double-broadcast.
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("partial broadcast failure: captures successful-leg hashes for audit even as payout fails", async () => {
    // Stage: 4 wallets funded, payout requires them all. Programmable adapter
    // wrapper throws on the 3rd signAndBroadcast call, simulating a mid-
    // batch RPC failure after 2 legs already landed on-chain. The audit
    // trail MUST preserve those 2 hashes so the operator can reconcile
    // orphan txs — prior to the allSettled fix, they were silently dropped.
    const balances = new Map<string, bigint>();
    const baseProbe = programmable(balances);
    let broadcastCallIdx = 0;
    const failingAdapter: ChainAdapter = {
      ...baseProbe.adapter,
      async signAndBroadcast(unsigned, key) {
        const thisCall = broadcastCallIdx;
        broadcastCallIdx += 1;
        if (thisCall === 2) {
          throw new Error(`simulated broadcast failure on leg #${thisCall}`);
        }
        return baseProbe.adapter.signAndBroadcast(unsigned, key);
      }
    };
    booted = await bootTestApp({ chains: [failingAdapter] });

    // Balances chosen so greedy-by-balance-desc picks exactly 3 wallets:
    //   a=700 (remaining 800), b=500 (remaining 300), c=400 (only 300 used).
    //   d=100 never gets picked because break triggers after cumulative>=required.
    const a = await seed(booted, "a");
    const b = await seed(booted, "b");
    const c = await seed(booted, "c");
    const d = await seed(booted, "d");
    balances.set(a.address, 700n);
    balances.set(b.address, 500n);
    balances.set(c.address, 400n);
    balances.set(d.address, 100n);

    const payout = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1500", // requires splitting across 3 wallets
      destinationAddress: GOOD_DEST,
      allowMultiSource: true
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.failed).toBe(1);
    expect(result.submitted).toBe(0);

    const [row] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, payout.id))
      .limit(1);
    expect(row?.status).toBe("failed");

    // Audit trail invariant: the two successful legs' hashes MUST be
    // persisted on the failed row so the operator knows what landed
    // on-chain. Without this, broadcasted-but-unaccounted-for txs are
    // invisible to the dashboard.
    expect(row?.txHashesJson).not.toBeNull();
    const auditedHashes = JSON.parse(row!.txHashesJson!);
    expect(auditedHashes).toHaveLength(2);
    expect(row?.txHash).toBe(auditedHashes[0]);

    // `lastError` mentions the partial-failure context so ops can triage.
    expect(row?.lastError).toMatch(/Multi-source partial failure/);

    // Structured log for the partial failure carries the orphan hashes and
    // per-leg failure reasons, giving ops an unambiguous audit entry.
    const partialFailLog = booted.logger.entries.find(
      (e) => e.message === "payout.multi_source.partial_failure"
    );
    expect(partialFailLog).toBeDefined();
    expect(partialFailLog?.fields?.legsSucceeded).toBe(2);
    expect(partialFailLog?.fields?.legsFailed).toBe(1);
  });

  it("defers when single-source fails AND allowMultiSource is false (default)", async () => {
    const balances = new Map<string, bigint>();
    const { adapter } = programmable(balances);
    booted = await bootTestApp({ chains: [adapter] });

    const w1 = await seed(booted, "w1");
    const w2 = await seed(booted, "w2");
    balances.set(w1.address, 500n);
    balances.set(w2.address, 500n);

    await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1000",
      destinationAddress: GOOD_DEST
      // allowMultiSource omitted → defaults to false
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("fails with INSUFFICIENT_TOTAL_BALANCE when even the sum of all wallets is short", async () => {
    const balances = new Map<string, bigint>();
    const { adapter } = programmable(balances);
    booted = await bootTestApp({ chains: [adapter] });

    const w1 = await seed(booted, "w1");
    const w2 = await seed(booted, "w2");
    balances.set(w1.address, 100n);
    balances.set(w2.address, 200n);

    const payout = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1000", // sum available = 300; short by 700
      destinationAddress: GOOD_DEST,
      allowMultiSource: true
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.failed).toBe(1);
    expect(result.submitted).toBe(0);

    const [row] = await booted.deps.db
      .select({ status: payouts.status, lastError: payouts.lastError })
      .from(payouts)
      .where(eq(payouts.id, payout.id))
      .limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toMatch(/Multi-source: available total/);
  });

  it("single-source success path is unaffected by the allowMultiSource flag being set", async () => {
    const balances = new Map<string, bigint>();
    const { adapter } = programmable(balances);
    booted = await bootTestApp({ chains: [adapter] });

    // One wallet has plenty; single-source should succeed, multi-source
    // path should NOT execute.
    const plenty = await seed(booted, "plenty");
    balances.set(plenty.address, 1_000_000n);

    const payout = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "100",
      destinationAddress: GOOD_DEST,
      allowMultiSource: true
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(1);

    const [row] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, payout.id))
      .limit(1);
    expect(row?.status).toBe("submitted");
    // Multi-source JSON fields stay null on single-source success.
    expect(row?.txHashesJson).toBeNull();
    expect(row?.sourceAddressesJson).toBeNull();
    expect(row?.sourceAddress).toBe(plenty.address);
  });

  it("caps legs at MAX_MULTI_SOURCE_LEGS (8) — doesn't pick a 9th wallet even if more are funded", async () => {
    const balances = new Map<string, bigint>();
    const { adapter } = programmable(balances);
    booted = await bootTestApp({ chains: [adapter] });

    // 10 wallets each with 100 balance. Amount requires 10 of them, but the
    // cap is 8 → insufficient total detected, payout fails (not deferred).
    const wallets = await Promise.all(
      Array.from({ length: 10 }, (_, i) => seed(booted, `hot-${i}`))
    );
    for (const w of wallets) balances.set(w.address, 100n);

    await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1000", // needs all 10; cap is 8 → 800 available
      destinationAddress: GOOD_DEST,
      allowMultiSource: true
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.failed).toBe(1);
  });
});
