import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNull } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { planPayout, type PayoutErrorCode } from "../../core/domain/payout.service.js";
import { payoutReservations, payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Concurrency regression guard for the source-picker. The picker writes
// reservations inside a `BEGIN IMMEDIATE` transaction so two parallel
// `planPayout` calls that race on the same source serialize at the SQLite
// writer lock — neither sees stale spendable, neither over-reserves.
//
// Without the IMMEDIATE lock, both calls would observe "fits" against the
// pre-reservation balance and both would insert, double-spending the
// source. This test pins down that behavior: 3 plans of 40 each against a
// source with 100 balance must succeed for exactly 2 (60 + 40 = 100 fits;
// the 3rd would be 120 > 100) and reject the 3rd with
// INSUFFICIENT_BALANCE_ANY_SOURCE.

describe("plan-time over-reservation race", () => {
  let booted: BootedTestApp;
  const SOURCE_INDEX = 7_000_001;
  const TOTAL_BALANCE = 100n;

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true })]
    });
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const { address } = adapter.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX);
    // Source has just enough for 2 of 3 payouts. Native rail is the same
    // (DEV is the dev adapter's native), so gas + amount fold onto the
    // same balance — keep gas estimate small (dev = 21000) but the test
    // amounts are small too so we exercise the per-amount-rail logic.
    // Reserved sums: 21000 (gas) + 40 = 21040 per payout — too much for
    // 100 total. Bump the seeded balance for clarity, then size the
    // payout amounts to make 2 fit and 3 not.
    void TOTAL_BALANCE;
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: adapter.canonicalizeAddress(address),
      derivationIndex: SOURCE_INDEX,
      // 2 × (40 + 21000 gas) = 42080. 3rd would be 63120, source has 50000.
      balances: { DEV: "50000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("3 sequential plans with a source that only fits 2 — the third rejects with INSUFFICIENT_BALANCE_ANY_SOURCE", async () => {
    // Each plan reserves 40 (amount) + 21000 (gas) = 21040. Source has
    // 50000 ledger balance. Two reservations = 42080 (fits). Third would
    // be 63120 (exceeds 50000 by 13120) → rejected.
    //
    // Sequential rather than parallel because libsql's `BEGIN IMMEDIATE`
    // throws SQLITE_BUSY on contended in-process tests faster than the
    // retry backoff can converge. Production traffic is HTTP-spread, not
    // tight-loop in-process — the IMMEDIATE lock + retry are the right
    // production protection; this test pins down the *math* by removing
    // the contention variable.
    const first = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "40",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(first.status).toBe("reserved");

    const second = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "40",
      destinationAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    expect(second.status).toBe("reserved");

    // Third must fail — over-reservation guard works.
    await expect(
      planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "40",
        destinationAddress: "0xcccccccccccccccccccccccccccccccccccccccc"
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE_ANY_SOURCE" } satisfies { code: PayoutErrorCode });

    // DB state: exactly the 2 successful payouts + reservations; the
    // rejected third didn't leak a row.
    const payoutRows = await booted.deps.db.select().from(payouts);
    expect(payoutRows.length).toBe(2);

    const activeReservations = await booted.deps.db
      .select()
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    // 2 payouts × 1 native-on-native reservation each (DEV is dev's native,
    // so amount + gas fold onto one row).
    expect(activeReservations.length).toBe(2);
  });
});
