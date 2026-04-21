import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  estimatePayoutFees,
  executeReservedPayouts,
  planPayout
} from "../../core/domain/payout.service.js";
import { payoutReservations, payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import type { ChainAdapter } from "../../core/ports/chain.port.js";
import type { ChainId, TxHash } from "../../core/types/chain.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// JIT gas top-up flow: when the merchant pays out a token (DEVT) on a chain
// whose native (DEV) the source address doesn't hold, the executor must
// pick a sponsor address with native DEV, broadcast a sponsor → source
// top-up tx, wait for it to confirm, and then broadcast the main token
// payout. The parent payout transitions planned → reserved → topping-up →
// submitted → confirmed; a sibling `gas_top_up` payout records the
// sponsor's debit on the ledger.
//
// We use a thin wrapper around the dev adapter to flip its `nativeSymbol`
// from "DEV" to "DEVN" so the picker treats DEVT as a token (≠ native) and
// triggers tier-B (with-sponsor) selection.

function topUpAdapter(): ChainAdapter {
  const base = devChainAdapter({ deterministicTxHashes: true });
  // Tracker for confirmation status the test can advance manually.
  const statuses = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
  return {
    ...base,
    nativeSymbol(_chainId: ChainId) {
      return "DEVN" as ReturnType<ChainAdapter["nativeSymbol"]>;
    },
    async getConfirmationStatus(_chainId: ChainId, txHash: TxHash) {
      return statuses.get(txHash) ?? { blockNumber: null, confirmations: 0, reverted: false };
    },
    // Expose the map for tests to mutate.
    confirmationStatuses: statuses
  } as ChainAdapter & { confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }> };
}

describe("JIT gas top-up — token payout from a source that lacks native", () => {
  let booted: BootedTestApp;
  let sourceAddress: string;
  let sponsorAddress: string;
  let adapter: ChainAdapter & { confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }> };

  const SOURCE_INDEX = 5_000_001;
  const SPONSOR_INDEX = 5_000_002;

  beforeEach(async () => {
    adapter = topUpAdapter() as typeof adapter;
    booted = await bootTestApp({ chains: [adapter] });
    const a = booted.deps.chains[0]!;
    const src = a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX);
    const spo = a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX);
    sourceAddress = a.canonicalizeAddress(src.address);
    sponsorAddress = a.canonicalizeAddress(spo.address);

    // Source: DEVT 100, native DEVN 0 → needs top-up.
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sourceAddress,
      derivationIndex: SOURCE_INDEX,
      balances: { DEVT: "100" }
    });
    // Sponsor: DEVN 1_000_000 → comfortable native to top up source.
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sponsorAddress,
      derivationIndex: SPONSOR_INDEX,
      balances: { DEVN: "1000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("estimate surfaces the source + sponsor + topUp.amountRaw", async () => {
    const result = await estimatePayoutFees(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      feeTier: "medium",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(result.source).not.toBeNull();
    expect(result.source!.address).toBe(sourceAddress);
    expect(result.topUp).toBeDefined();
    expect(result.topUp!.required).toBe(true);
    expect(result.topUp!.sponsor).not.toBeNull();
    expect(result.topUp!.sponsor!.address).toBe(sponsorAddress);
    expect(BigInt(result.topUp!.amountRaw)).toBeGreaterThan(0n);
  });

  it("end-to-end: planned → topping-up → submitting → submitted, with reservations on both source and sponsor", async () => {
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(planned.status).toBe("reserved");
    // Plan-time selection already wrote the source + planned top-up amount.
    expect(planned.sourceAddress).toBe(sourceAddress);
    expect(planned.topUpSponsorAddress).toBe(sponsorAddress);
    expect(planned.topUpAmountRaw).not.toBeNull();

    // First tick: selectSource picks source + sponsor, inserts reservations,
    // broadcasts the top-up tx, transitions parent to topping-up.
    let result = await executeReservedPayouts(booted.deps);
    expect(result.attempted).toBe(1);
    expect(result.submitted).toBe(1); // sibling gas_top_up was inserted + broadcast

    const [parentAfterTopUp] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(parentAfterTopUp?.status).toBe("topping-up");
    expect(parentAfterTopUp?.topUpTxHash).not.toBeNull();
    expect(parentAfterTopUp?.topUpSponsorAddress).toBe(sponsorAddress);

    // Sibling gas_top_up row exists with parentPayoutId set.
    const [sibling] = await booted.deps.db
      .select()
      .from(payouts)
      .where(and(eq(payouts.parentPayoutId, planned.id), eq(payouts.kind, "gas_top_up")))
      .limit(1);
    expect(sibling).toBeDefined();
    expect(sibling?.sourceAddress).toBe(sponsorAddress);
    expect(sibling?.destinationAddress).toBe(sourceAddress);

    // Two active reservations: source's DEVT debit + sponsor's DEVN debit.
    const active = await booted.deps.db
      .select({
        role: payoutReservations.role,
        address: payoutReservations.address,
        token: payoutReservations.token,
        amountRaw: payoutReservations.amountRaw
      })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    const sourceRes = active.filter((r) => r.role === "source");
    const sponsorRes = active.filter((r) => r.role === "top_up_sponsor");
    expect(sourceRes.length).toBeGreaterThanOrEqual(1);
    expect(sponsorRes.length).toBe(1);
    expect(sponsorRes[0]!.address).toBe(sponsorAddress);
    expect(sponsorRes[0]!.token).toBe("DEVN");

    // Mark the top-up tx confirmed.
    adapter.confirmationStatuses.set(parentAfterTopUp!.topUpTxHash!, {
      blockNumber: 1,
      confirmations: 30,
      reverted: false
    });

    // Second tick: executeTopUp sees the top-up confirmed, confirms the
    // sibling, and broadcasts the main DEVT tx. Parent transitions to submitted.
    result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(1);

    const [parentAfterMain] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(parentAfterMain?.status).toBe("submitted");
    expect(parentAfterMain?.txHash).not.toBeNull();
    // topUpTxHash should also still be set — the parent row carries both
    // the gas-top-up tx and the main tx for audit.
    expect(parentAfterMain?.topUpTxHash).not.toBeNull();

    // Sponsor reservation released after top-up confirmation; source
    // reservation still held until the main tx confirms.
    const stillActive = await booted.deps.db
      .select({ role: payoutReservations.role })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    expect(stillActive.find((r) => r.role === "top_up_sponsor")).toBeUndefined();
    expect(stillActive.find((r) => r.role === "source")).toBeDefined();
  });

  it("planPayout rejects synchronously with NO_GAS_SPONSOR_AVAILABLE when token holder exists but no funded sponsor", async () => {
    // Drain the sponsor by booting fresh with only the source seeded.
    await booted.close();
    booted = await bootTestApp({ chains: [adapter] });
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sourceAddress,
      derivationIndex: SOURCE_INDEX,
      balances: { DEVT: "100" }
    });

    // planPayout's transaction-time selection surfaces this synchronously
    // (no row inserted, no executor tick required).
    await expect(
      planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEVT",
        amountRaw: "30",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({ code: "NO_GAS_SPONSOR_AVAILABLE" });

    // Nothing was inserted — plan is all-or-nothing.
    const rows = await booted.deps.db.select().from(payouts);
    expect(rows.length).toBe(0);
  });

  it("top-up tx reverts on-chain → parent fails AND sibling cascade-fails (no orphan submitted row)", async () => {
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    // First tick: source picked at plan time, sibling inserted, top-up
    // broadcast. Parent → topping-up.
    await executeReservedPayouts(booted.deps);
    const [parentAfterBroadcast] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(parentAfterBroadcast?.status).toBe("topping-up");
    expect(parentAfterBroadcast?.topUpTxHash).not.toBeNull();

    // Mark the top-up tx reverted on-chain.
    adapter.confirmationStatuses.set(parentAfterBroadcast!.topUpTxHash!, {
      blockNumber: 1,
      confirmations: 1,
      reverted: true
    });

    // Second tick: executeTopUp sees reverted, cascades fail to sibling.
    await executeReservedPayouts(booted.deps);

    const [parentAfterRevert] = await booted.deps.db
      .select({ status: payouts.status, lastError: payouts.lastError })
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(parentAfterRevert?.status).toBe("failed");
    expect(parentAfterRevert?.lastError).toContain("TOP_UP_REVERTED");

    // Sibling MUST also be marked failed — otherwise it sits in 'submitted'
    // forever and the watchdog WARNs about it indefinitely.
    const [sibling] = await booted.deps.db
      .select({ status: payouts.status, lastError: payouts.lastError })
      .from(payouts)
      .where(and(eq(payouts.parentPayoutId, planned.id), eq(payouts.kind, "gas_top_up")))
      .limit(1);
    expect(sibling?.status).toBe("failed");
    expect(sibling?.lastError).toContain("TOP_UP_REVERTED");

    // All reservations released.
    const stillActive = await booted.deps.db
      .select({ id: payoutReservations.id })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    expect(stillActive.length).toBe(0);
  });
});
