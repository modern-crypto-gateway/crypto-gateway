import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { reconcileLedgerToChain } from "../../core/domain/reconcile-balances.service.js";
import { computeSpendable } from "../../core/domain/balance-snapshot.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import type { ChainAdapter } from "../../core/ports/chain.port.js";
import type { Address, ChainId } from "../../core/types/chain.js";
import type { AmountRaw } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

const TEST_MASTER_SEED = "test test test test test test test test test test test junk";
const SOURCE_INDEX = 7_100_001;

// Drives reconcileLedgerToChain with a controllable on-chain balance
// (getAccountBalances), against a ledger seeded to a different value — exactly
// the ledger ⇄ chain drift we're reconciling.
describe("reconcileLedgerToChain", () => {
  let booted: BootedTestApp;
  let sourceAddress: string;
  const onChain = new Map<string, bigint>(); // token -> on-chain balance (chain 999 only)

  function reconcileAdapter(): ChainAdapter {
    const base = devChainAdapter({ deterministicTxHashes: true });
    return {
      ...base,
      async getAccountBalances(args: { chainId: ChainId; address: Address }) {
        if (args.chainId !== 999) return [];
        return [...onChain.entries()].map(([token, amt]) => ({
          token: token as TokenSymbol,
          amountRaw: amt.toString() as AmountRaw
        }));
      }
    } as ChainAdapter;
  }

  beforeEach(async () => {
    onChain.clear();
    booted = await bootTestApp({ chains: [reconcileAdapter()] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    // Ledger: confirmed inbound of 100 DEVT, no outbound → settled ledger = 100.
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

  const spendable = () =>
    computeSpendable(booted.deps, { chainId: 999, address: sourceAddress, token: "DEVT" });

  it("dry-run previews the delta without writing", async () => {
    onChain.set("DEVT", 60n); // ledger 100, chain 60 → over-count by 40

    const preview = await reconcileLedgerToChain(booted.deps, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.adjusted).toBe(0);
    const d = preview.deltas.find((x) => x.token === "DEVT" && x.address === sourceAddress);
    expect(d).toBeDefined();
    expect(d!.ledgerRaw).toBe("100");
    expect(d!.onChainRaw).toBe("60");
    expect(d!.deltaRaw).toBe("-40");

    // Nothing written → ledger unchanged.
    expect(await spendable()).toBe(100n);
  });

  it("apply snaps the ledger to the chain, and a re-run is idempotent", async () => {
    onChain.set("DEVT", 60n);

    const applied = await reconcileLedgerToChain(booted.deps, { dryRun: false });
    expect(applied.dryRun).toBe(false);
    expect(applied.adjusted).toBe(1);
    expect(await spendable()).toBe(60n); // ledger now matches chain

    // Re-run: no drift left, nothing written.
    const again = await reconcileLedgerToChain(booted.deps, { dryRun: false });
    expect(again.adjusted).toBe(0);
    expect(again.deltas.find((x) => x.token === "DEVT" && x.address === sourceAddress)).toBeUndefined();
    expect(await spendable()).toBe(60n);
  });

  it("corrects an under-count (chain higher than ledger) too", async () => {
    onChain.set("DEVT", 140n); // ledger 100, chain 140 → under-count by 40

    const applied = await reconcileLedgerToChain(booted.deps, { dryRun: false });
    expect(applied.adjusted).toBe(1);
    expect(await spendable()).toBe(140n);
  });
});
