import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { executeReservedPayouts, planPayout } from "../../core/domain/payout.service.js";
import { payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import type { ChainAdapter } from "../../core/ports/chain.port.js";
import type { Address, ChainId, TxHash } from "../../core/types/chain.js";
import type { AmountRaw } from "../../core/types/money.js";
import type { TokenSymbol } from "../../core/types/token.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";
const SOURCE_INDEX = 6_100_001;
const DEST = "0xdddddddddddddddddddddddddddddddddddddddd";

// The pre-broadcast on-chain balance gate (broadcastMain) reads getBalance and
// decides whether to broadcast, re-size, or fail cheap. These tests drive it by
// making getBalance return a controllable "on-chain" balance that DIFFERS from
// the ledger — simulating the drift that produced the production loop. The
// source is funded generously in the LEDGER (so the picker selects it with no
// top-up → a single direct broadcast), and a counter proves whether anything
// was ever broadcast (i.e. whether gas would have been spent).
describe("pre-broadcast on-chain balance gate", () => {
  let booted: BootedTestApp;
  let sourceAddress: string;
  const onChain = new Map<string, bigint>(); // token symbol -> on-chain balance
  let broadcasts = 0;

  function gateAdapter(): ChainAdapter & {
    confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>;
  } {
    const base = devChainAdapter({ deterministicTxHashes: true });
    const statuses = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    return {
      ...base,
      nativeSymbol(_chainId: ChainId) {
        return "DEVN" as ReturnType<ChainAdapter["nativeSymbol"]>;
      },
      async getBalance(args: { chainId: ChainId; address: Address; token: TokenSymbol }): Promise<AmountRaw> {
        const v = onChain.get(args.token as string);
        return (v === undefined ? "1000000000000000000000" : v.toString()) as AmountRaw;
      },
      async signAndBroadcast(unsigned: Parameters<ChainAdapter["signAndBroadcast"]>[0], pk: string) {
        broadcasts += 1;
        return base.signAndBroadcast(unsigned, pk);
      },
      async getConfirmationStatus(_chainId: ChainId, txHash: TxHash) {
        return statuses.get(txHash) ?? { blockNumber: null, confirmations: 0, reverted: false };
      },
      confirmationStatuses: statuses
    } as ChainAdapter & {
      confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>;
    };
  }

  beforeEach(async () => {
    onChain.clear();
    broadcasts = 0;
    const adapter = gateAdapter();
    booted = await bootTestApp({ chains: [adapter] });
    const a = booted.deps.chains[0]!;
    sourceAddress = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_INDEX).address);
    // Ledger: plenty of token + native, so the picker takes the direct path
    // (no top-up). Each test overrides the *on-chain* DEVT balance to simulate
    // drift between ledger and chain.
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

  it("fails a fixed-amount payout cheaply (no broadcast) when the source can't cover it on-chain", async () => {
    onChain.set("DEVT", 20n); // ledger says 100, chain says 20 < requested 30
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: DEST
    });

    await executeReservedPayouts(booted.deps);

    const [row] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.txHash).toBeNull();
    expect(row?.lastError).toContain("below the payout amount");
    expect(broadcasts).toBe(0); // never broadcast → no gas burned
  });

  it("re-sizes a consolidation sweep down to the real on-chain balance", async () => {
    onChain.set("DEVT", 20n); // planned 30, chain 20 → sweep the real 20
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: DEST,
      internalKind: "consolidation_sweep",
      forceSourceAddress: sourceAddress
    });

    await executeReservedPayouts(booted.deps);

    const [row] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(row?.status).toBe("submitted");
    expect(row?.txHash).not.toBeNull();
    expect(row?.amountRaw).toBe("20"); // re-sized down to the on-chain balance
    expect(broadcasts).toBe(1);
  });

  it("fails a consolidation sweep cheaply when the source is empty on-chain", async () => {
    onChain.set("DEVT", 0n); // ledger drift: ledger says 100, chain says 0
    const planned = await planPayout(booted.deps, {
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEVT",
      amountRaw: "30",
      destinationAddress: DEST,
      internalKind: "consolidation_sweep",
      forceSourceAddress: sourceAddress
    });

    await executeReservedPayouts(booted.deps);

    const [row] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, planned.id)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.txHash).toBeNull();
    expect(row?.lastError).toContain("nothing to consolidate");
    expect(broadcasts).toBe(0); // never broadcast → no gas burned
  });
});
