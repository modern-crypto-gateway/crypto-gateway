import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { estimatePayoutFees, planPayout } from "../../core/domain/payout.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Native MAX-send guard: if the merchant requests an amount that would
// consume the source's entire native balance with no headroom for gas,
// surface MAX_AMOUNT_EXCEEDS_NET_SPENDABLE with a `suggestedAmountRaw`
// field telling the merchant what amount actually fits.

describe("native payout MAX-send handling", () => {
  let booted: BootedTestApp;
  let sourceAddress: string;
  const SEED_INDEX = 9_876_543;
  const TOTAL_BALANCE = 50_000n;
  const ESTIMATED_GAS = 21_000n; // dev adapter's flat quote

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [devChainAdapter({ deterministicTxHashes: true })]
    });
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const { address } = adapter.deriveAddress(TEST_MASTER_SEED, SEED_INDEX);
    sourceAddress = adapter.canonicalizeAddress(address);
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sourceAddress,
      derivationIndex: SEED_INDEX,
      balances: { DEV: TOTAL_BALANCE.toString() }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("rejects amount = full native balance with MAX_AMOUNT_EXCEEDS_NET_SPENDABLE + suggestedAmountRaw", async () => {
    // Asking for the full balance leaves nothing for gas.
    await expect(
      estimatePayoutFees(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: TOTAL_BALANCE.toString(),
        feeTier: "medium",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      code: "MAX_AMOUNT_EXCEEDS_NET_SPENDABLE",
      details: {
        suggestedAmountRaw: (TOTAL_BALANCE - ESTIMATED_GAS).toString(),
        candidateAddress: sourceAddress
      }
    });
  });

  it("accepts amount = balance − gas (the suggested value)", async () => {
    const safeAmount = (TOTAL_BALANCE - ESTIMATED_GAS).toString();
    const result = await estimatePayoutFees(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: safeAmount,
      feeTier: "medium",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(result.source).not.toBeNull();
    expect(result.source!.address).toBe(sourceAddress);
  });

  it("planPayout enforces the same guard at create time (synchronous reject)", async () => {
    // planPayout now runs selectSource at plan time and surfaces MAX
    // synchronously — merchant gets an immediate, actionable response
    // instead of a queued payout that fails on the next executor tick.
    await expect(
      planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: TOTAL_BALANCE.toString(),
        feeTier: "medium",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).rejects.toMatchObject({
      code: "MAX_AMOUNT_EXCEEDS_NET_SPENDABLE",
      details: { suggestedAmountRaw: (TOTAL_BALANCE - ESTIMATED_GAS).toString() }
    });
  });
});
