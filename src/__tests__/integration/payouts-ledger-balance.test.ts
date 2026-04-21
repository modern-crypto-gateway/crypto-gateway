import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNull } from "drizzle-orm";
import { computeSpendable } from "../../core/domain/balance-snapshot.service.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { executeReservedPayouts, planPayout } from "../../core/domain/payout.service.js";
import { payoutReservations } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Verifies the new ledger-balance primitive end-to-end:
//   spendable = sum(confirmed inbound) - sum(confirmed outbound) - sum(active reservations).
// Confirmed inbound credits, then plan a payout (writes a reservation, drops
// spendable), then confirm it (releases the reservation but the confirmed
// outbound debit takes its place — net is the same).

describe("ledger-derived spendable balance", () => {
  let booted: BootedTestApp;
  let sourceAddress: string;
  const SEED_INDEX = 1_234_567;

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true })]
    });
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const { address } = adapter.deriveAddress(TEST_MASTER_SEED, SEED_INDEX);
    sourceAddress = adapter.canonicalizeAddress(address);
    // Seed 1_000_000 DEV inbound — comfortably above the dev adapter's flat
    // 21000 gas estimate plus any plausible payout amount in this test.
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sourceAddress,
      derivationIndex: SEED_INDEX,
      balances: { DEV: "1000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("reflects the seeded inbound credit on a fresh address", async () => {
    const spend = await computeSpendable(booted.deps, {
      chainId: 999,
      address: sourceAddress,
      token: "DEV"
    });
    expect(spend.toString()).toBe("1000000");
  });

  it("subtracts an active reservation while the payout is in flight", async () => {
    await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(1);

    const remaining = await computeSpendable(booted.deps, {
      chainId: 999,
      address: sourceAddress,
      token: "DEV"
    });
    // 1_000_000 inbound − 21030 reserved (amount + flat gas estimate, both
    // on the same DEV symbol since DEV is its own native here).
    expect(remaining.toString()).toBe((1_000_000n - 21_030n).toString());

    const active = await booted.deps.db
      .select({ id: payoutReservations.id })
      .from(payoutReservations)
      .where(isNull(payoutReservations.releasedAt));
    expect(active.length).toBeGreaterThan(0);
  });
});
