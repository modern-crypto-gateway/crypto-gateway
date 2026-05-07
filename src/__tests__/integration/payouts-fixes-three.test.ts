import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  estimatePayoutFees,
  planPayout,
  reconcileFailedPayoutGasBurns
} from "../../core/domain/payout.service.js";
import { payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import type { ChainAdapter } from "../../core/ports/chain.port.js";
import type { Address, ChainId, TxHash } from "../../core/types/chain.js";
import type { AmountRaw } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Three concurrent fixes covered here:
//   1. `reconcileFailedPayoutGasBurns` — retries gas_burn synthesis when the
//      RPC didn't have the receipt at fail-time. Without this, ledger
//      drifts permanently every time a payout reverts mid-flight.
//   2. `feeWallet` diagnostic block on /payouts/estimate — surfaces the
//      registered fee wallet's live balance + topUp shortfall so operators
//      can see WHY a fee wallet wasn't picked as sponsor (instead of an
//      opaque `no_gas_sponsor_available`).
//   3. `hasSufficientFreeGas` adapter probe — Tron-style delegated-energy
//      sources qualify as Tier A direct picks even with 0 native balance.
//      Verified here against a wrapper adapter that opts into the probe;
//      the planner should pick the address as direct (no top-up planned)
//      when the probe returns true.

// Wrapper that flips DEV→DEVN (so DEVT becomes "token" not "native") and
// optionally implements the new adapter hooks for each test.
function makeTestAdapter(opts: {
  consumedFeeByTxHash?: Map<string, AmountRaw>;
  freeGasAddresses?: Set<string>;
}): ChainAdapter & {
  freeGasAddresses?: Set<string>;
  consumedFeeByTxHash?: Map<string, AmountRaw>;
} {
  const base = devChainAdapter({ deterministicTxHashes: true });
  const consumedFeeByTxHash = opts.consumedFeeByTxHash ?? new Map<string, AmountRaw>();
  const freeGasAddresses = opts.freeGasAddresses ?? new Set<string>();
  const statuses = new Map<
    string,
    { blockNumber: number | null; confirmations: number; reverted: boolean }
  >();

  const adapter: ChainAdapter & {
    consumedFeeByTxHash: Map<string, AmountRaw>;
    freeGasAddresses: Set<string>;
  } = {
    ...base,
    nativeSymbol(_chainId: ChainId) {
      return "DEVN" as ReturnType<ChainAdapter["nativeSymbol"]>;
    },
    async getConfirmationStatus(_chainId: ChainId, txHash: TxHash) {
      return statuses.get(txHash) ?? { blockNumber: null, confirmations: 0, reverted: false };
    },
    async getConsumedNativeFee(_chainId: ChainId, txHash: TxHash) {
      const fee = consumedFeeByTxHash.get(txHash);
      return fee ?? null;
    },
    async hasSufficientFreeGas(args: {
      readonly chainId: ChainId;
      readonly address: Address;
      readonly token: TokenSymbol;
    }) {
      return freeGasAddresses.has(args.address);
    },
    consumedFeeByTxHash,
    freeGasAddresses
  };

  return adapter;
}

describe("Fix 1: reconcileFailedPayoutGasBurns", () => {
  let booted: BootedTestApp;
  let adapter: ChainAdapter & { consumedFeeByTxHash: Map<string, AmountRaw> };
  const SOURCE_INDEX = 7_000_001;
  let sourceAddress: string;

  beforeEach(async () => {
    adapter = makeTestAdapter({}) as typeof adapter;
    booted = await bootTestApp({ chains: [adapter] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sourceAddress,
      derivationIndex: SOURCE_INDEX,
      balances: { DEVT: "100", DEVN: "1000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("creates a gas_burn debit row when the receipt becomes available", async () => {
    // Set up a payout row that simulates a failed broadcast: status='failed',
    // txHash present, no gas_burn child. Mimics what the failPayout path
    // leaves behind when getConsumedNativeFee returned null (deferred).
    const failedId = globalThis.crypto.randomUUID();
    const failedTxHash = "0xfeedface" + "0".repeat(56);
    const now = booted.deps.clock.now().getTime();
    await booted.deps.db.insert(payouts).values({
      id: failedId,
      merchantId: MERCHANT_ID,
      kind: "standard",
      parentPayoutId: null,
      status: "failed",
      chainId: 999,
      token: "DEVT",
      amountRaw: "10",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceAddress,
      txHash: failedTxHash,
      lastError: "Transaction reverted on-chain",
      createdAt: now,
      submittedAt: now,
      updatedAt: now
    });

    // Initially RPC has no receipt — reconciler should leave it as
    // stillDeferred and write nothing.
    let result = await reconcileFailedPayoutGasBurns(booted.deps);
    expect(result.scanned).toBe(1);
    expect(result.recorded).toBe(0);
    expect(result.stillDeferred).toBe(1);

    let burns = await booted.deps.db
      .select()
      .from(payouts)
      .where(and(eq(payouts.kind, "gas_burn"), eq(payouts.parentPayoutId, failedId)));
    expect(burns).toHaveLength(0);

    // Now the receipt is "available" — adapter returns a fee. Reconciler
    // should pick this up on the next pass and write the gas_burn row.
    adapter.consumedFeeByTxHash.set(failedTxHash, "12345" as AmountRaw);

    result = await reconcileFailedPayoutGasBurns(booted.deps);
    expect(result.scanned).toBe(1);
    expect(result.recorded).toBe(1);
    expect(result.stillDeferred).toBe(0);

    burns = await booted.deps.db
      .select()
      .from(payouts)
      .where(and(eq(payouts.kind, "gas_burn"), eq(payouts.parentPayoutId, failedId)));
    expect(burns).toHaveLength(1);
    expect(burns[0]!.amountRaw).toBe("12345");
    expect(burns[0]!.sourceAddress).toBe(sourceAddress);
    expect(burns[0]!.txHash).toBe(failedTxHash);
    expect(burns[0]!.status).toBe("confirmed");
    expect(burns[0]!.token).toBe("DEVN");
  });

  it("is idempotent — re-running after a successful record is a no-op", async () => {
    const failedId = globalThis.crypto.randomUUID();
    const failedTxHash = "0xdeadbeef" + "0".repeat(56);
    const now = booted.deps.clock.now().getTime();
    await booted.deps.db.insert(payouts).values({
      id: failedId,
      merchantId: MERCHANT_ID,
      kind: "standard",
      parentPayoutId: null,
      status: "failed",
      chainId: 999,
      token: "DEVT",
      amountRaw: "10",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceAddress,
      txHash: failedTxHash,
      createdAt: now,
      submittedAt: now,
      updatedAt: now
    });
    adapter.consumedFeeByTxHash.set(failedTxHash, "5000" as AmountRaw);

    // First pass writes the burn.
    let result = await reconcileFailedPayoutGasBurns(booted.deps);
    expect(result.recorded).toBe(1);

    // Second pass: gas_burn child already exists, the candidate is skipped
    // pre-recordGasBurnDebit so neither recorded nor stillDeferred fires.
    result = await reconcileFailedPayoutGasBurns(booted.deps);
    expect(result.recorded).toBe(0);
    expect(result.stillDeferred).toBe(0);

    const burns = await booted.deps.db
      .select()
      .from(payouts)
      .where(and(eq(payouts.kind, "gas_burn"), eq(payouts.parentPayoutId, failedId)));
    expect(burns).toHaveLength(1); // not duplicated
  });
});

describe("Fix 2: feeWallet diagnostic block on /payouts/estimate", () => {
  // The real fee-wallet flow ties to capability="top-up" + a registered
  // fee wallet. The dev adapter reports capability="none", so the
  // diagnostic block isn't emitted on dev. We verify the absence here as
  // a stable contract — Tron-side coverage lives alongside the Tron
  // adapter tests once the production path stabilizes.
  let booted: BootedTestApp;
  let adapter: ChainAdapter;
  const SOURCE_INDEX = 7_001_001;

  beforeEach(async () => {
    adapter = makeTestAdapter({});
    booted = await bootTestApp({ chains: [adapter] });
    const a = booted.deps.chains[0]!;
    const src = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: src,
      derivationIndex: SOURCE_INDEX,
      balances: { DEVT: "100", DEVN: "1000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("omits feeWallet field on chains without 'top-up' capability", async () => {
    const result = await estimatePayoutFees(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(result.feeWallet).toBeUndefined();
  });
});

describe("Fix 3: hasSufficientFreeGas overrides Tier A native check", () => {
  // When the chain adapter's `hasSufficientFreeGas` probe returns true
  // for a candidate, the planner must accept that candidate as Tier A
  // direct even if its on-chain native balance is 0 — Tron's
  // delegated-energy model relies on this. A wrapper adapter that
  // returns true for one specific address verifies the path end-to-end.
  let booted: BootedTestApp;
  let adapter: ChainAdapter & { freeGasAddresses: Set<string> };
  const SOURCE_INDEX = 7_002_001;
  let sourceAddress: string;

  beforeEach(async () => {
    adapter = makeTestAdapter({}) as typeof adapter;
    booted = await bootTestApp({ chains: [adapter] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    // Token-rich source with ZERO native — would normally be rejected
    // for Tier A and forced into the top-up path.
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: sourceAddress,
      derivationIndex: SOURCE_INDEX,
      balances: { DEVT: "100" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("picks the source as direct (no top-up) when the adapter probe returns true", async () => {
    // Mark the source as having delegated free gas.
    adapter.freeGasAddresses.add(sourceAddress);

    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(planned.status).toBe("reserved");
    expect(planned.sourceAddress).toBe(sourceAddress);
    // The defining assertion: NO top-up was planned even though native = 0.
    // The picker accepted the source as Tier A on the strength of the
    // free-gas probe alone.
    expect(planned.topUpAmountRaw).toBeNull();
    expect(planned.topUpSponsorAddress).toBeNull();
  });

  it("estimate response surfaces the source as direct (no topUp) when free gas applies", async () => {
    adapter.freeGasAddresses.add(sourceAddress);

    const result = await estimatePayoutFees(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(result.source).not.toBeNull();
    expect(result.source!.address).toBe(sourceAddress);
    expect(result.topUp).toBeUndefined();
  });
});
