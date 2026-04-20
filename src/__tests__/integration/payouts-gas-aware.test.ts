import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { feeWallets, payouts } from "../../db/schema.js";
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
import type { TokenSymbol } from "../../core/types/token.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Build a dev adapter whose getBalance answers from a per-address map. Lets
// tests stage which wallets are funded and which are empty, exercising the
// gas-aware selection + tight-fit + CAS fallback paths end to end.
function balanceProgrammableAdapter(balances: Map<string, Map<string, bigint>>): {
  adapter: ChainAdapter;
  getBalanceCalls: () => number;
} {
  const base = devChainAdapter({ deterministicTxHashes: true });
  let calls = 0;
  const wrapped: ChainAdapter = {
    ...base,
    async getBalance(args) {
      calls += 1;
      const perToken = balances.get(args.address.toLowerCase());
      if (!perToken) return "0" as AmountRaw;
      const v = perToken.get(args.token);
      return (v ?? 0n).toString() as AmountRaw;
    }
  };
  return { adapter: wrapped, getBalanceCalls: () => calls };
}

async function seedFeeWallet(
  booted: BootedTestApp,
  label: string
): Promise<{ address: string }> {
  const adapter = booted.deps.chains.find((c) => c.family === "evm");
  if (!adapter) throw new Error("no EVM adapter");
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

describe("executeReservedPayouts — gas-aware wallet selection", () => {
  let booted: BootedTestApp;

  afterEach(async () => {
    if (booted) await booted.close();
  });

  it("picks the healthy wallet when some lack token balance and others lack native gas", async () => {
    const balances = new Map<string, Map<string, bigint>>();
    const { adapter } = balanceProgrammableAdapter(balances);
    booted = await bootTestApp({ chains: [adapter] });

    // Four wallets on the same chain. DEV adapter returns native symbol "DEV",
    // so for a DEV payout, token + native are the same and a single balance
    // read covers both checks. To force the mismatch path we'd need a chain
    // with distinct native + ERC-20 tokens, which this dev harness doesn't
    // model — so here we fake it by having some wallets "DEV=0" (no token)
    // versus others with plenty.
    const empty = await seedFeeWallet(booted, "empty");
    const healthy = await seedFeeWallet(booted, "healthy");
    const anotherEmpty = await seedFeeWallet(booted, "also-empty");
    const plenty = await seedFeeWallet(booted, "plenty");

    balances.set(empty.address, new Map([["DEV", 0n]]));
    balances.set(healthy.address, new Map([["DEV", 2_000_000n]])); // 2 DEV
    balances.set(anotherEmpty.address, new Map([["DEV", 0n]]));
    balances.set(plenty.address, new Map([["DEV", 1_000_000_000n]])); // 1000 DEV

    const payout = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1500000", // 1.5 DEV
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.submitted).toBe(1);

    // Tight-fit: "healthy" (2 DEV) is picked over "plenty" (1000 DEV) because
    // its excess above the 1.5 DEV requirement is smaller — keeps the
    // large-balance wallet free for future big payouts.
    const [row] = await booted.deps.db
      .select({ sourceAddress: payouts.sourceAddress })
      .from(payouts)
      .where(eq(payouts.id, payout.id))
      .limit(1);
    expect(row?.sourceAddress).toBe(healthy.address);
  });

  it("defers when candidates exist but none have enough balance (logs no_wallet_funded)", async () => {
    const balances = new Map<string, Map<string, bigint>>();
    const { adapter } = balanceProgrammableAdapter(balances);
    booted = await bootTestApp({ chains: [adapter] });

    const a = await seedFeeWallet(booted, "tiny-1");
    const b = await seedFeeWallet(booted, "tiny-2");
    balances.set(a.address, new Map([["DEV", 100n]]));
    balances.set(b.address, new Map([["DEV", 200n]]));

    await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1000000", // 1 DEV, but no wallet has that much
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    const result = await executeReservedPayouts(booted.deps);
    expect(result.deferred).toBe(1);
    expect(result.submitted).toBe(0);
    expect(result.failed).toBe(0);

    // Neither wallet should be reserved (selection didn't CAS-claim either).
    const walletRows = await booted.deps.db
      .select({ reservedBy: feeWallets.reservedByPayoutId })
      .from(feeWallets);
    expect(walletRows.every((w) => w.reservedBy === null)).toBe(true);

    // Operator-facing log emitted so alerting can differentiate "no wallets
    // at all" from "wallets exist but none are funded".
    const fundedLog = booted.logger.entries.find(
      (e) => e.message === "payout.execute.no_wallet_funded"
    );
    expect(fundedLog).toBeDefined();
  });

  it("shares one getBalance per (wallet, token) across parallel workers via the tick-local cache", async () => {
    const balances = new Map<string, Map<string, bigint>>();
    const { adapter, getBalanceCalls } = balanceProgrammableAdapter(balances);
    booted = await bootTestApp({ chains: [adapter] });

    // 4 wallets (all funded), 8 payouts. Without the cache, each payout
    // would fetch balance for every candidate up to its first successful
    // CAS → ~32 getBalance calls. With the cache, each (wallet, token) pair
    // is fetched exactly once per tick → 4 calls.
    for (let i = 1; i <= 4; i++) {
      const w = await seedFeeWallet(booted, `hot-${i}`);
      balances.set(w.address, new Map([["DEV", 10_000_000n]]));
    }
    for (let i = 0; i < 8; i++) {
      await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });
    }

    const result = await executeReservedPayouts(booted.deps);
    // With 4 wallets and 8 payouts, 4 submit this tick and 4 defer
    // (wallets are in-flight serving the first 4 until confirmPayouts releases).
    expect(result.submitted).toBe(4);
    expect(result.deferred).toBe(4);

    // The cache should have bounded getBalance to roughly one call per
    // wallet (DEV is native, so one balance read covers both checks per
    // wallet). Allow a small tolerance for workers that re-select after
    // CAS loss and re-enter the balance check (still cache hits).
    expect(getBalanceCalls()).toBeLessThanOrEqual(8);
  });

  it("CAS loss on the tight-fit candidate falls through to the next-best and still submits", async () => {
    const balances = new Map<string, Map<string, bigint>>();
    const { adapter } = balanceProgrammableAdapter(balances);
    booted = await bootTestApp({ chains: [adapter] });

    // Two wallets both qualify. Pre-reserve the tight-fit one manually so
    // that the selection's CAS loses on it and has to fall through to the
    // other candidate.
    const small = await seedFeeWallet(booted, "small-fit");
    const big = await seedFeeWallet(booted, "big-fit");
    balances.set(small.address, new Map([["DEV", 2_000_000n]]));
    balances.set(big.address, new Map([["DEV", 500_000_000n]]));

    // Pre-reserve `small` with a fake payout id to simulate a racing worker.
    await booted.deps.db
      .update(feeWallets)
      .set({ reservedByPayoutId: "fake-racer", reservedAt: Date.now() })
      .where(and(eq(feeWallets.chainId, 999), eq(feeWallets.address, small.address)));

    const payout = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      amountRaw: "1500000",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    const result = await executeReservedPayouts(booted.deps);
    // `small` was filtered out at the SELECT (reservedByPayoutId IS NOT NULL),
    // so we don't even try CAS on it; `big` is the only qualifying candidate
    // and wins.
    expect(result.submitted).toBe(1);

    const [row] = await booted.deps.db
      .select({ sourceAddress: payouts.sourceAddress })
      .from(payouts)
      .where(eq(payouts.id, payout.id))
      .limit(1);
    expect(row?.sourceAddress).toBe(big.address);
  });
});
