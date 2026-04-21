import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  cancelPayout,
  executeReservedPayouts,
  planPayout,
  type PayoutId
} from "../../core/domain/payout.service.js";
import { payoutReservations, payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

describe("cancelPayout", () => {
  let booted: BootedTestApp;
  let sourceAddress: string;
  const SOURCE_INDEX = 8_000_001;

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true })]
    });
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const { address } = adapter.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX);
    sourceAddress = adapter.canonicalizeAddress(address);
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sourceAddress,
      derivationIndex: SOURCE_INDEX,
      balances: { DEV: "1000000000000000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("cancels a reserved payout, releases reservations, frees the source's spendable", async () => {
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "100",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(planned.status).toBe("reserved");

    // Pre-cancel: at least one active reservation row exists.
    const beforeActive = await booted.deps.db
      .select({ id: payoutReservations.id })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    expect(beforeActive.length).toBeGreaterThan(0);

    const canceled = await cancelPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      payoutId: planned.id
    });
    expect(canceled.status).toBe("canceled");

    // Reservations released atomically with the status flip.
    const afterActive = await booted.deps.db
      .select({ id: payoutReservations.id })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    expect(afterActive.length).toBe(0);
  });

  it("cancel is idempotent on an already-canceled payout", async () => {
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "100",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    await cancelPayout(booted.deps, { merchantId: MERCHANT_ID, payoutId: planned.id });

    // Second call returns the same canceled row, no error.
    const second = await cancelPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      payoutId: planned.id
    });
    expect(second.status).toBe("canceled");
  });

  it("rejects cancel on a payout that's already broadcast (PAYOUT_NOT_CANCELABLE)", async () => {
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "100",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    // Drive the executor so the payout transitions to 'submitted'.
    await executeReservedPayouts(booted.deps);
    const [postExec] = await booted.deps.db
      .select({ status: payouts.status })
      .from(payouts)
      .where(eq(payouts.id, planned.id))
      .limit(1);
    expect(postExec?.status).toBe("submitted");

    await expect(
      cancelPayout(booted.deps, { merchantId: MERCHANT_ID, payoutId: planned.id })
    ).rejects.toMatchObject({ code: "PAYOUT_NOT_CANCELABLE" });
  });

  it("rejects cancel on a non-existent payout", async () => {
    await expect(
      cancelPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        payoutId: "00000000-0000-0000-0000-deadbeef0000" as PayoutId
      })
    ).rejects.toMatchObject({ code: "PAYOUT_NOT_FOUND" });
  });

  it("rejects cancel from a different merchant (cross-merchant access surfaces as 404)", async () => {
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "100",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    await expect(
      cancelPayout(booted.deps, {
        merchantId: "00000000-0000-0000-0000-000000000099",
        payoutId: planned.id
      })
    ).rejects.toMatchObject({ code: "PAYOUT_NOT_FOUND" });

    // Reservation untouched.
    const stillActive = await booted.deps.db
      .select({ id: payoutReservations.id })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    expect(stillActive.length).toBeGreaterThan(0);
  });
});
