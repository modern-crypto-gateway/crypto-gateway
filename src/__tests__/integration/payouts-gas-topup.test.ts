import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  confirmPayouts,
  estimatePayoutFees,
  executeReservedPayouts,
  listHeldPayouts,
  planPayout,
  recoverHeldPayout,
  reconcileConfirmedPayoutGasBurns,
  reconcileUnknownBroadcastPayouts
} from "../../core/domain/payout.service.js";
import { computeSpendable } from "../../core/domain/balance-snapshot.service.js";
import { payoutReservations, payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import type { ChainAdapter, FeeTierQuote } from "../../core/ports/chain.port.js";
import type { ChainId, TxHash } from "../../core/types/chain.js";
import type { AmountRaw } from "../../core/types/money.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import type { EstimateArgs, UnsignedTx } from "../../core/types/unsigned-tx.js";

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

  it("top-up confirms, main tx fails → parent='failed', SIBLING STAYS 'confirmed' (sponsor's gas debit is real)", async () => {
    // Wrap the adapter so signAndBroadcast succeeds on the first call
    // (the top-up) but throws on the second call (the main tx). This
    // exercises the SOURCE_BROADCAST_FAILED cascade: the sponsor's
    // debit to the source ALREADY landed on-chain, so the sibling
    // gas_top_up must stay 'confirmed' for ledger accuracy — only the
    // parent's reservations get released.
    let sigCount = 0;
    const wrappedAdapter = {
      ...adapter,
      async signAndBroadcast(unsigned: Parameters<ChainAdapter["signAndBroadcast"]>[0], pk: string) {
        sigCount += 1;
        if (sigCount === 1) return adapter.signAndBroadcast(unsigned, pk);
        throw new Error("simulated main-tx broadcast failure (post-top-up)");
      }
    } as ChainAdapter & { confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }> };
    wrappedAdapter.confirmationStatuses = adapter.confirmationStatuses;

    // Re-boot with the wrapped adapter; re-seed sources.
    await booted.close();
    booted = await bootTestApp({ chains: [wrappedAdapter] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    sponsorAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceAddress,
      derivationIndex: SOURCE_INDEX, balances: { DEVT: "100" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sponsorAddress,
      derivationIndex: SPONSOR_INDEX, balances: { DEVN: "1000000" }
    });

    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    // Tick 1: top-up broadcasts.
    await executeReservedPayouts(booted.deps);
    const [parentAfterTopUp] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(parentAfterTopUp?.status).toBe("topping-up");

    // Advance confirmations past threshold.
    wrappedAdapter.confirmationStatuses.set(parentAfterTopUp!.topUpTxHash!, {
      blockNumber: 1, confirmations: 30, reverted: false
    });

    // Tick 2: top-up confirms → main tx broadcast throws.
    await executeReservedPayouts(booted.deps);

    const [parentAfterFail] = await booted.deps.db
      .select({ status: payouts.status, lastError: payouts.lastError })
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(parentAfterFail?.status).toBe("failed");
    expect(parentAfterFail?.lastError).toContain("SOURCE_BROADCAST_FAILED");

    // Sibling MUST stay confirmed — the sponsor's native moved on-chain
    // and the ledger needs to reflect that. Failing the sibling would
    // inflate the sponsor's spendable for future plans.
    const [sibling] = await booted.deps.db
      .select({ status: payouts.status })
      .from(payouts)
      .where(and(eq(payouts.parentPayoutId, planned.id), eq(payouts.kind, "gas_top_up")))
      .limit(1);
    expect(sibling?.status).toBe("confirmed");

    // Parent's reservations released. Sibling's sponsor reservation was
    // released when the top-up confirmed (on the previous tick).
    const stillActive = await booted.deps.db
      .select({ id: payoutReservations.id })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    expect(stillActive.length).toBe(0);
  });

  it("recovers a topping-up payout when an ambiguous main broadcast later appears on-chain", async () => {
    let sigCount = 0;
    const incoming: DetectedTransfer[] = [];
    const wrappedAdapter = {
      ...adapter,
      async signAndBroadcast(unsigned: Parameters<ChainAdapter["signAndBroadcast"]>[0], pk: string) {
        sigCount += 1;
        if (sigCount === 1) return adapter.signAndBroadcast(unsigned, pk);
        throw new Error("request timed out after 10000ms");
      },
      async scanIncoming() {
        return incoming;
      }
    } as ChainAdapter & { confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }> };
    wrappedAdapter.confirmationStatuses = adapter.confirmationStatuses;

    await booted.close();
    booted = await bootTestApp({ chains: [wrappedAdapter] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    sponsorAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceAddress,
      derivationIndex: SOURCE_INDEX, balances: { DEVT: "100" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sponsorAddress,
      derivationIndex: SPONSOR_INDEX, balances: { DEVN: "1000000" }
    });

    const destinationAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress
    });

    await executeReservedPayouts(booted.deps);
    const [parentAfterTopUp] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    wrappedAdapter.confirmationStatuses.set(parentAfterTopUp!.topUpTxHash!, {
      blockNumber: 1, confirmations: 30, reverted: false
    });

    await executeReservedPayouts(booted.deps);
    const [held] = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(held?.status).toBe("topping-up");
    expect(held?.txHash).toBeNull();
    expect(held?.broadcastAttemptedAt).not.toBeNull();
    expect(held?.lastError).toContain("outcome unknown");

    const recoveredTxHash = `0x${"ab".repeat(32)}` as TxHash;
    incoming.push({
      chainId: 999 as ChainId,
      txHash: recoveredTxHash,
      logIndex: 0,
      fromAddress: sourceAddress,
      toAddress: destinationAddress,
      token: "DEVT",
      amountRaw: "30",
      blockNumber: 123,
      confirmations: 2,
      seenAt: new Date(),
      onchainTime: null
    });

    const result = await reconcileUnknownBroadcastPayouts(booted.deps, { minAgeMs: 0 });
    expect(result).toEqual({
      scanned: 1,
      recovered: 1,
      stillUnknown: 0,
      ambiguous: 0,
      errors: 0,
      rebroadcastScheduled: 0
    });

    const [recovered] = await booted.deps.db
      .select({ status: payouts.status, txHash: payouts.txHash, lastError: payouts.lastError })
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(recovered?.status).toBe("submitted");
    expect(recovered?.txHash).toBe(recoveredTxHash);
    expect(recovered?.lastError).toBeNull();
  });

  it("guards then auto-re-broadcasts a held payout: blocked while a pending outbound exists, released once the source is clear, then it lands", async () => {
    let sigCount = 0;
    // Drives the getOutboundNonceState probe. broadcastMain captures `latest`
    // (7) as the pre-broadcast baseline; the reconciler re-broadcasts only when
    // the live state is byte-for-byte that baseline (latest == pending == 7).
    let nonceState: { latest: number; pending: number } | null = { latest: 7, pending: 7 };
    const wrappedAdapter = {
      ...adapter,
      async signAndBroadcast(unsigned: Parameters<ChainAdapter["signAndBroadcast"]>[0], pk: string) {
        sigCount += 1;
        // 1 = top-up broadcast (ok), 2 = main broadcast (ambiguous transport
        // error → held), 3 = the guarded re-broadcast (lands).
        if (sigCount === 2) throw new Error("request timed out after 10000ms");
        return adapter.signAndBroadcast(unsigned, pk);
      },
      async scanIncoming() {
        // The sweep never appears on-chain — the reconciler can't recover it
        // and must fall through to the guarded re-broadcast decision.
        return [];
      },
      async getOutboundNonceState() {
        return nonceState;
      }
    } as ChainAdapter & { confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }> };
    wrappedAdapter.confirmationStatuses = adapter.confirmationStatuses;

    await booted.close();
    booted = await bootTestApp({ chains: [wrappedAdapter] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    sponsorAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceAddress,
      derivationIndex: SOURCE_INDEX, balances: { DEVT: "100" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sponsorAddress,
      derivationIndex: SPONSOR_INDEX, balances: { DEVN: "1000000" }
    });

    const destinationAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress
    });

    // Tick 1: broadcast the top-up, transition to topping-up.
    await executeReservedPayouts(booted.deps);
    const [parentAfterTopUp] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    wrappedAdapter.confirmationStatuses.set(parentAfterTopUp!.topUpTxHash!, {
      blockNumber: 1, confirmations: 30, reverted: false
    });

    // Tick 2: top-up confirmed → main broadcast → ambiguous timeout → held.
    await executeReservedPayouts(booted.deps);
    const [held] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(held?.status).toBe("topping-up");
    expect(held?.txHash).toBeNull();
    expect(held?.broadcastAttemptedAt).not.toBeNull();
    expect(held?.lastError).toContain("outcome unknown");

    // A pending tx now sits in the mempool (pending 8 > baseline 7) → it could
    // be ours, so the reconciler must HOLD, not release (re-broadcasting could
    // double-send).
    nonceState = { latest: 7, pending: 8 };
    const blocked = await reconcileUnknownBroadcastPayouts(booted.deps, {
      minAgeMs: 0, rebroadcastAfterMs: 0
    });
    expect(blocked.rebroadcastScheduled).toBe(0);
    expect(blocked.stillUnknown).toBe(1);
    const [stillHeld] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(stillHeld?.broadcastAttemptedAt).not.toBeNull();
    expect(stillHeld?.status).toBe("topping-up");
    expect(stillHeld?.preBroadcastNonce).toBe(7);

    // The pending tx dropped — the source nonce is exactly the pre-broadcast
    // baseline again (latest == pending == 7), proving our tx never landed →
    // safe to re-broadcast: slot released, row stays topping-up for the executor.
    nonceState = { latest: 7, pending: 7 };
    const released = await reconcileUnknownBroadcastPayouts(booted.deps, {
      minAgeMs: 0, rebroadcastAfterMs: 0
    });
    expect(released.rebroadcastScheduled).toBe(1);
    expect(released.stillUnknown).toBe(0);
    const [afterRelease] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(afterRelease?.status).toBe("topping-up");
    expect(afterRelease?.broadcastAttemptedAt).toBeNull();
    expect(afterRelease?.lastError).toContain("REBROADCAST_SCHEDULED");

    // Tick 3: executor rebuilds + re-broadcasts; this attempt lands.
    await executeReservedPayouts(booted.deps);
    const [resent] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(resent?.status).toBe("submitted");
    expect(resent?.txHash).not.toBeNull();
  });

  it("recoverHeldPayout: verifies the real tx, drives a held leg to submitted/confirmed (posting the source debit), and rejects bad hashes", async () => {
    let sigCount = 0;
    const incoming: DetectedTransfer[] = [];
    const wrappedAdapter = {
      ...adapter,
      async signAndBroadcast(unsigned: Parameters<ChainAdapter["signAndBroadcast"]>[0], pk: string) {
        sigCount += 1;
        // 1 = top-up (ok), 2 = main broadcast (ambiguous transport error → held).
        if (sigCount === 1) return adapter.signAndBroadcast(unsigned, pk);
        throw new Error("request timed out after 10000ms");
      },
      async scanIncoming() {
        return incoming;
      }
    } as ChainAdapter & { confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }> };
    wrappedAdapter.confirmationStatuses = adapter.confirmationStatuses;

    await booted.close();
    booted = await bootTestApp({ chains: [wrappedAdapter] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    sponsorAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceAddress,
      derivationIndex: SOURCE_INDEX, balances: { DEVT: "100" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sponsorAddress,
      derivationIndex: SPONSOR_INDEX, balances: { DEVN: "1000000" }
    });

    const destinationAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID, chainId: 999, token: "DEVT", amountRaw: "30", destinationAddress
    });

    // Tick 1: top-up → topping-up.
    await executeReservedPayouts(booted.deps);
    const [afterTopUp] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    wrappedAdapter.confirmationStatuses.set(afterTopUp!.topUpTxHash!, {
      blockNumber: 1, confirmations: 30, reverted: false
    });

    // Tick 2: main broadcast → ambiguous → held.
    await executeReservedPayouts(booted.deps);
    const [held] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(held?.status).toBe("topping-up");
    expect(held?.txHash).toBeNull();

    // The held leg shows up in the recovery queue with its identifying fields.
    const queue = await listHeldPayouts(booted.deps, {});
    expect(queue.map((q) => q.id)).toContain(planned.id);
    const queued = queue.find((q) => q.id === planned.id)!;
    expect(queued.sourceAddress).toBe(sourceAddress);
    expect(queued.destinationAddress).toBe(destinationAddress);
    expect(queued.amountRaw).toBe("30");
    expect(queued.heldForMs).not.toBeNull();

    const realTxHash = `0x${"cd".repeat(32)}` as TxHash;
    const revertedTxHash = `0x${"ee".repeat(32)}` as TxHash;
    const mismatchTxHash = `0x${"ab".repeat(32)}` as TxHash;

    // A reverted tx moved no funds → rejected (would post a phantom debit).
    wrappedAdapter.confirmationStatuses.set(revertedTxHash, { blockNumber: 2, confirmations: 9, reverted: true });
    await expect(recoverHeldPayout(booted.deps, { payoutId: planned.id, txHash: revertedTxHash }))
      .rejects.toMatchObject({ code: "RECOVERY_TX_REVERTED" });

    // Mined + not reverted but not THIS leg's transfer (absent from the scan) → rejected.
    wrappedAdapter.confirmationStatuses.set(mismatchTxHash, { blockNumber: 3, confirmations: 9, reverted: false });
    await expect(recoverHeldPayout(booted.deps, { payoutId: planned.id, txHash: mismatchTxHash }))
      .rejects.toMatchObject({ code: "RECOVERY_TX_MISMATCH" });

    // The real successful sweep is visible on-chain at the destination.
    incoming.push({
      chainId: 999 as ChainId, txHash: realTxHash, logIndex: 0,
      fromAddress: sourceAddress, toAddress: destinationAddress,
      token: "DEVT", amountRaw: "30", blockNumber: 100, confirmations: 30, seenAt: new Date(), onchainTime: null
    });
    wrappedAdapter.confirmationStatuses.set(realTxHash, { blockNumber: 100, confirmations: 30, reverted: false });

    const recovered = await recoverHeldPayout(booted.deps, { payoutId: planned.id, txHash: realTxHash });
    expect(recovered.status).toBe("submitted");

    // Once recovered (txHash set) it drops out of the recovery queue.
    const queueAfter = await listHeldPayouts(booted.deps, {});
    expect(queueAfter.map((q) => q.id)).not.toContain(planned.id);

    const [afterRecover] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(afterRecover?.status).toBe("submitted");
    expect(afterRecover?.txHash).toBe(realTxHash);
    expect(afterRecover?.broadcastAttemptedAt).toBeNull();
    expect(afterRecover?.lastError).toBeNull();

    // confirmPayouts flips it to confirmed → the source debit finally posts.
    await confirmPayouts(booted.deps);
    const [confirmed] = await booted.deps.db
      .select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(confirmed?.status).toBe("confirmed");
    expect(
      await computeSpendable(booted.deps, { chainId: 999, address: sourceAddress, token: "DEVT" })
    ).toBe(70n);

    // Already recovered → no longer a held leg.
    await expect(recoverHeldPayout(booted.deps, { payoutId: planned.id, txHash: realTxHash }))
      .rejects.toMatchObject({ code: "PAYOUT_NOT_RECOVERABLE" });
  });

  it("Fix B: a confirmed gas_top_up CREDITS the source's native in the ledger (no re-top-up loop)", async () => {
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID, chainId: 999, token: "DEVT", amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    await executeReservedPayouts(booted.deps); // tick 1: top-up broadcast
    const [p1] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(p1!.topUpAmountRaw).not.toBeNull();
    adapter.confirmationStatuses.set(p1!.topUpTxHash!, { blockNumber: 1, confirmations: 30, reverted: false });
    await executeReservedPayouts(booted.deps); // tick 2: top-up confirmed + main broadcast

    const topUp = BigInt(p1!.topUpAmountRaw!);
    // The source's native (DEVN) now reflects the confirmed top-up — previously
    // this read 0 forever, causing the planner to re-top-up every payout.
    const sourceNative = await computeSpendable(booted.deps, { chainId: 999, address: sourceAddress, token: "DEVN" });
    expect(sourceNative).toBe(topUp);
    // And the sponsor is debited by the same amount (double-entry closes).
    const sponsorNative = await computeSpendable(booted.deps, { chainId: 999, address: sponsorAddress, token: "DEVN" });
    expect(sponsorNative).toBe(1_000_000n - topUp);
  });

  it("Fix C: reconcileConfirmedPayoutGasBurns debits real gas for a confirmed payout (idempotent, skips UTXO n/a)", async () => {
    const FEE = "7000";
    const feeAdapter = {
      ...adapter,
      async getConsumedNativeFee(_c: ChainId, _t: TxHash): Promise<AmountRaw | null> {
        return FEE as AmountRaw;
      }
    } as ChainAdapter & { confirmationStatuses: typeof adapter.confirmationStatuses };
    feeAdapter.confirmationStatuses = adapter.confirmationStatuses;

    await booted.close();
    booted = await bootTestApp({ chains: [feeAdapter] });
    const a = booted.deps.chains[0]!;
    const src = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: src, derivationIndex: SOURCE_INDEX, balances: { DEVN: "1000000" }
    });

    // A confirmed native payout that spent 100 + (real gas FEE, not yet debited).
    const payoutId = globalThis.crypto.randomUUID();
    const now = booted.deps.clock.now().getTime();
    await booted.deps.db.insert(payouts).values({
      id: payoutId, merchantId: MERCHANT_ID, kind: "standard", parentPayoutId: null,
      status: "confirmed", chainId: 999, token: "DEVN", amountRaw: "100",
      quotedAmountUsd: null, quotedRate: null, feeTier: null, feeQuotedNative: null, batchId: null,
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceAddress: src,
      txHash: "0x" + "ab".repeat(32), feeEstimateNative: null, topUpTxHash: null,
      topUpSponsorAddress: null, topUpAmountRaw: null, lastError: null,
      createdAt: now, submittedAt: now, confirmedAt: now, updatedAt: now, broadcastAttemptedAt: now,
      confirmationThreshold: 1, confirmationTiersJson: null, webhookUrl: null, webhookSecretCiphertext: null
    });

    const before = await computeSpendable(booted.deps, { chainId: 999, address: src, token: "DEVN" });
    expect(before).toBe(1_000_000n - 100n); // payout debit only, no gas yet

    const r = await reconcileConfirmedPayoutGasBurns(booted.deps);
    expect(r.recorded).toBe(1);

    const [burn] = await booted.deps.db
      .select().from(payouts)
      .where(and(eq(payouts.kind, "gas_burn"), eq(payouts.parentPayoutId, payoutId))).limit(1);
    expect(burn).toBeDefined();
    expect(burn!.amountRaw).toBe(FEE);
    expect(burn!.sourceAddress).toBe(src);

    const after = await computeSpendable(booted.deps, { chainId: 999, address: src, token: "DEVN" });
    expect(after).toBe(1_000_000n - 100n - BigInt(FEE)); // gas now debited

    // Idempotent: the anti-join excludes the now-reconciled row.
    const r2 = await reconcileConfirmedPayoutGasBurns(booted.deps);
    expect(r2.recorded).toBe(0);
    expect(r2.scanned).toBe(0);
  });

  it("Fix A2: an insufficient-native broadcast failure RE-TOPS-UP and then succeeds (not terminal fail)", async () => {
    // Adapter with a rising gas quote: cheap at plan time, then spikes after
    // the first main-tx attempt so the re-quote exceeds the first top-up
    // (forcing selectSource down the with_sponsor re-top-up path). The main
    // (DEVT) broadcast throws the EVM insufficient-native error once.
    let gasRaw = "21000";
    let mainAttempts = 0;
    const wrapped = {
      ...adapter,
      async quoteFeeTiers(_args: EstimateArgs): Promise<FeeTierQuote> {
        return {
          low: { tier: "low", nativeAmountRaw: gasRaw as AmountRaw },
          medium: { tier: "medium", nativeAmountRaw: gasRaw as AmountRaw },
          high: { tier: "high", nativeAmountRaw: gasRaw as AmountRaw },
          tieringSupported: false,
          nativeSymbol: "DEVN" as ReturnType<ChainAdapter["nativeSymbol"]>
        };
      },
      async signAndBroadcast(
        unsigned: UnsignedTx,
        pk: string,
        opts?: { readonly feePayerPrivateKey?: string }
      ): Promise<TxHash> {
        const raw = unsigned.raw as { token?: string };
        if (raw.token === "DEVT") {
          mainAttempts += 1;
          if (mainAttempts === 1) {
            gasRaw = "200000"; // gas spiked — re-quote will now outrun top-up #1
            throw new Error(
              "insufficient native balance for broadcast (balance < value + gas × maxFeePerGas): balance=1 wei, gas_budget=2 wei"
            );
          }
        }
        return adapter.signAndBroadcast(unsigned, pk, opts);
      }
    } as ChainAdapter & { confirmationStatuses: typeof adapter.confirmationStatuses };
    wrapped.confirmationStatuses = adapter.confirmationStatuses;

    await booted.close();
    booted = await bootTestApp({ chains: [wrapped] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    sponsorAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceAddress, derivationIndex: SOURCE_INDEX, balances: { DEVT: "100" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sponsorAddress, derivationIndex: SPONSOR_INDEX, balances: { DEVN: "5000000" }
    });

    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID, chainId: 999, token: "DEVT", amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    // Drive ticks, confirming each top-up, until the parent reaches a terminal-ish
    // state (submitted) or we give up. Asserts the leg recovers via re-top-up.
    let reservedAgainSeen = false;
    for (let i = 0; i < 8; i += 1) {
      await executeReservedPayouts(booted.deps);
      const [p] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
      if (p!.status === "submitted") break;
      if (p!.status === "reserved" && i > 0) reservedAgainSeen = true; // bounced back for re-top-up
      if (p!.status === "topping-up" && p!.topUpTxHash) {
        adapter.confirmationStatuses.set(p!.topUpTxHash, { blockNumber: i + 1, confirmations: 30, reverted: false });
      }
    }

    const [finalRow] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(finalRow!.status).toBe("submitted"); // recovered, not failed
    expect(mainAttempts).toBe(2); // failed once, succeeded on the re-top-up
    expect(reservedAgainSeen).toBe(true); // observed the re-top-up bounce
    // Two gas_top_up children: the original + the broadcast-time re-top-up.
    const topups = await booted.deps.db
      .select().from(payouts)
      .where(and(eq(payouts.parentPayoutId, planned.id), eq(payouts.kind, "gas_top_up")));
    expect(topups.length).toBe(2);
  });
});
