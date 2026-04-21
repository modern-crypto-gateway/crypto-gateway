import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { payoutReservations, payouts } from "../../db/schema.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  confirmPayouts,
  executeReservedPayouts,
  planPayout
} from "../../core/domain/payout.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

let nextSeedIndex = 1_000_000;
async function seedFeeWallet(
  booted: BootedTestApp,
  args: { label: string; balanceRaw?: string }
): Promise<{ address: string }> {
  const adapter = booted.deps.chains.find((c) => c.family === "evm");
  if (!adapter) throw new Error("seedFeeWallet: no EVM adapter in test deps");
  const index = nextSeedIndex++;
  const { address } = adapter.deriveAddress(TEST_MASTER_SEED, index);
  const canonical = adapter.canonicalizeAddress(address);
  // Default to a generously funded source: enough DEV for the largest test
  // amount plus comfortable native gas headroom.
  const balanceRaw = args.balanceRaw ?? "1000000000000000000";
  await seedFundedPoolAddress(booted, {
    chainId: 999,
    family: "evm",
    address: canonical,
    derivationIndex: index,
    balances: { DEV: balanceRaw }
  });
  return { address: canonical };
}

describe("PayoutService.planPayout", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp();
    // planPayout now runs source selection synchronously inside an
    // IMMEDIATE transaction and throws if no HD address has enough
    // balance. Seed a well-funded source so the "validation path" tests
    // in this describe block don't trip on source selection.
    await seedFeeWallet(booted, { label: "plan-test-source" });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("creates a reserved payout row with the destination canonicalized and a source picked", async () => {
    const payout = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "500000",
      // Uppercase hex — adapter canonicalizes to lowercase.
      destinationAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    // Plan-time selection wrote reservations and set the source; status
    // skips the legacy 'planned' state entirely.
    expect(payout.status).toBe("reserved");
    expect(payout.destinationAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(payout.sourceAddress).not.toBeNull();
    expect(payout.txHash).toBeNull();
  });

  it("rejects unknown merchants and unsupported tokens", async () => {
    await expect(
      planPayout(booted.deps, {
        merchantId: "00000000-0000-0000-0000-ffffffffffff",
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({ code: "MERCHANT_NOT_FOUND" });

    await expect(
      planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "USDC", // USDC isn't on dev chain 999
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({ code: "TOKEN_NOT_SUPPORTED" });
  });

  it("rejects an invalid destination address for the chain's family", async () => {
    await expect(
      planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "not-an-address"
      })
    ).rejects.toMatchObject({ code: "INVALID_DESTINATION" });
  });

  it("emits payout.planned", async () => {
    const events: string[] = [];
    booted.deps.events.subscribeAll((e) => { events.push(e.type); });
    await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(events).toContain("payout.planned");
  });
});

describe("PayoutService.executeReservedPayouts", () => {
  it("reserves a fee wallet, broadcasts, and promotes to 'submitted'", async () => {
    const booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true })]
    });
    try {
      const { address: feeAddress } = await seedFeeWallet(booted, { label: "hot-1" });

      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "500",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });

      const result = await executeReservedPayouts(booted.deps);
      expect(result).toEqual({ attempted: 1, submitted: 1, failed: 0, deferred: 0 });

      const [row] = await booted.deps.db
        .select({ status: payouts.status, tx_hash: payouts.txHash, source_address: payouts.sourceAddress })
        .from(payouts)
        .limit(1);
      expect(row?.status).toBe("submitted");
      expect(row?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(row?.source_address).toBe(feeAddress);

      // Source wallet is still reserved by this payout (no confirmation yet).
      const activeRows = await booted.deps.db
        .select({ id: payoutReservations.id })
        .from(payoutReservations)
        .where(isNull(payoutReservations.releasedAt));
      expect(activeRows.length).toBeGreaterThan(0);
    } finally {
      await booted.close();
    }
  });

  it("planPayout rejects synchronously when no HD source has enough balance", async () => {
    const booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true })]
    });
    try {
      // Pool addresses exist (default boot seeds them) but none are funded
      // with DEV — ledger spendable is 0 for every candidate. Plan-time
      // source selection rejects with INSUFFICIENT_BALANCE_ANY_SOURCE;
      // nothing reaches the executor.
      await expect(
        planPayout(booted.deps, {
          merchantId: MERCHANT_ID,
          chainId: 999,
          token: "DEV",
          amountRaw: "1",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE_ANY_SOURCE" });

      // No payout row was inserted — plan is all-or-nothing.
      const rows = await booted.deps.db.select().from(payouts);
      expect(rows.length).toBe(0);
    } finally {
      await booted.close();
    }
  });

  it("multiple payouts can share one funded source as long as cumulative balance covers them all", async () => {
    const booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true })]
    });
    try {
      // Single HD source with comfortably-large balance — both payouts
      // reserve from it concurrently in the new ledger-based model.
      await seedFeeWallet(booted, { label: "shared-source", balanceRaw: "1000000000000000000" });

      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });
      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      });

      const result = await executeReservedPayouts(booted.deps);
      expect(result.attempted).toBe(2);
      expect(result.submitted).toBe(2);

      const counts = await booted.deps.db
        .select({ status: payouts.status, n: sql<number>`COUNT(*)` })
        .from(payouts)
        .groupBy(payouts.status);
      const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)]));
      expect(byStatus).toEqual({ submitted: 2 });
    } finally {
      await booted.close();
    }
  });

  it("moves to 'failed' and releases the fee wallet if signAndBroadcast throws", async () => {
    // Dev adapter that throws on signAndBroadcast by overriding via a wrapper.
    const base = devChainAdapter({ deterministicTxHashes: true });
    const failing = {
      ...base,
      async signAndBroadcast(): Promise<never> {
        throw new Error("simulated broadcast failure");
      }
    };
    const booted = await bootTestApp({ chains: [failing] });
    try {
      await seedFeeWallet(booted, { label: "hot-1" });

      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });

      const result = await executeReservedPayouts(booted.deps);
      expect(result).toEqual({ attempted: 1, submitted: 0, failed: 1, deferred: 0 });

      const [row] = await booted.deps.db
        .select({ status: payouts.status, last_error: payouts.lastError })
        .from(payouts)
        .limit(1);
      expect(row?.status).toBe("failed");
      expect(row?.last_error).toContain("simulated broadcast failure");

      // The fee wallet must be released so future retries can use it.
      const released = await booted.deps.db
        .select({ id: payoutReservations.id })
        .from(payoutReservations).where(isNull(payoutReservations.releasedAt))
        .limit(1);
      expect(released.length).toBe(0);
    } finally {
      await booted.close();
    }
  });
});

describe("PayoutService.confirmPayouts", () => {
  it("promotes submitted payouts to confirmed and releases the fee wallet", async () => {
    const confirmations = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    const booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true, confirmationStatuses: confirmations })]
    });
    try {
      await seedFeeWallet(booted, { label: "hot-1" });
      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });
      await executeReservedPayouts(booted.deps);

      // Read back the deterministic tx hash to drive the sweeper.
      const [row] = await booted.deps.db
        .select({ tx_hash: payouts.txHash })
        .from(payouts)
        .limit(1);
      expect(row?.tx_hash).toBeTruthy();
      confirmations.set(row!.tx_hash!, { blockNumber: 100, confirmations: 5, reverted: false });

      const events: string[] = [];
      booted.deps.events.subscribeAll((e) => { events.push(e.type); });

      const sweep = await confirmPayouts(booted.deps);
      expect(sweep).toEqual({ checked: 1, confirmed: 1, failed: 0 });

      const [after] = await booted.deps.db
        .select({ status: payouts.status, confirmed_at: payouts.confirmedAt })
        .from(payouts)
        .limit(1);
      expect(after?.status).toBe("confirmed");
      expect(after?.confirmed_at).not.toBeNull();

      const released = await booted.deps.db
        .select({ id: payoutReservations.id })
        .from(payoutReservations).where(isNull(payoutReservations.releasedAt))
        .limit(1);
      expect(released.length).toBe(0);

      expect(events).toContain("payout.confirmed");
    } finally {
      await booted.close();
    }
  });

  it("flags reverted txs as failed, releases the wallet, and emits payout.failed", async () => {
    const confirmations = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    const booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true, confirmationStatuses: confirmations })]
    });
    try {
      await seedFeeWallet(booted, { label: "hot-1" });
      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });
      await executeReservedPayouts(booted.deps);
      const [row] = await booted.deps.db
        .select({ tx_hash: payouts.txHash })
        .from(payouts)
        .limit(1);
      confirmations.set(row!.tx_hash!, { blockNumber: 100, confirmations: 5, reverted: true });

      const sweep = await confirmPayouts(booted.deps);
      expect(sweep).toEqual({ checked: 1, confirmed: 0, failed: 1 });

      const [after] = await booted.deps.db
        .select({ status: payouts.status, last_error: payouts.lastError })
        .from(payouts)
        .limit(1);
      expect(after?.status).toBe("failed");
      expect(after?.last_error).toContain("reverted");

      const released = await booted.deps.db
        .select({ id: payoutReservations.id })
        .from(payoutReservations).where(isNull(payoutReservations.releasedAt))
        .limit(1);
      expect(released.length).toBe(0);
    } finally {
      await booted.close();
    }
  });

  it("released fee wallet is immediately available to the next payout", async () => {
    const confirmations = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    const booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true, confirmationStatuses: confirmations })]
    });
    try {
      await seedFeeWallet(booted, { label: "hot-1" });

      // First payout: plan, submit, confirm.
      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });
      await executeReservedPayouts(booted.deps);
      const [first] = await booted.deps.db
        .select({ tx_hash: payouts.txHash })
        .from(payouts)
        .orderBy(asc(payouts.createdAt))
        .limit(1);
      confirmations.set(first!.tx_hash!, { blockNumber: 1, confirmations: 5, reverted: false });
      await confirmPayouts(booted.deps);

      // Second payout: plan, submit. Should succeed — wallet was released.
      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      });
      const result = await executeReservedPayouts(booted.deps);
      expect(result).toEqual({ attempted: 1, submitted: 1, failed: 0, deferred: 0 });
    } finally {
      await booted.close();
    }
  });
});
