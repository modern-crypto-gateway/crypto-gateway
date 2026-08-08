import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp } from "../helpers/boot.js";
import { executeReservedPayouts } from "../../core/domain/payout.service.js";
import { addressPool, payoutReservations, payouts } from "../../db/schema.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import type { BuildTransferArgs } from "../../core/types/unsigned-tx.js";
import type { AmountRaw } from "../../core/types/money.js";

// broadcastMain ordering: the pre-broadcast balance gate must run BEFORE the
// gas-prep hook (Tron energy rental in production), so that (1) a re-sized
// consolidation sweep preps with the EFFECTIVE amount — prepping with the
// drifted-high planned amount made the Tron prep's transfer simulation
// revert, silently dropping the rental and burning TRX for the whole
// transfer — and (2) doomed payouts fail cheap before any rental money is
// spent.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

async function bootWithGatedSource(args: { sourceBalance: string }) {
  const prepCalls: BuildTransferArgs[] = [];
  const balances = new Map<string, AmountRaw>();
  const booted = await bootTestApp({
    chains: [
      devChainAdapter({
        deterministicTxHashes: true,
        balancesByAddress: balances,
        prepareGasForBroadcast: async (a) => {
          prepCalls.push(a);
          return { kind: "none" };
        }
      })
    ]
  });
  const [poolRow] = await booted.deps.db
    .select()
    .from(addressPool)
    .where(eq(addressPool.family, "evm"))
    .limit(1);
  balances.set(poolRow!.address, args.sourceBalance as AmountRaw);

  const id = globalThis.crypto.randomUUID();
  const now = booted.deps.clock.now().getTime();
  await booted.deps.db.insert(payouts).values({
    id,
    merchantId: MERCHANT_ID,
    kind: "consolidation_sweep",
    status: "reserved",
    chainId: 999,
    token: "DEVT",
    amountRaw: "100",
    destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceAddress: poolRow!.address,
    confirmationThreshold: 1,
    createdAt: now,
    updatedAt: now
  });
  await booted.deps.db.insert(payoutReservations).values({
    id: globalThis.crypto.randomUUID(),
    payoutId: id,
    role: "source",
    chainId: 999,
    address: poolRow!.address,
    token: "DEVT",
    amountRaw: "100",
    createdAt: now,
    releasedAt: null
  });
  return { booted, prepCalls, payoutId: id };
}

describe("broadcastMain — balance gate runs before the gas-prep hook", () => {
  it("a re-sized sweep preps with the EFFECTIVE amount, not the drifted plan", async () => {
    const { booted, prepCalls, payoutId } = await bootWithGatedSource({ sourceBalance: "60" });
    try {
      const result = await executeReservedPayouts(booted.deps);
      expect(result.submitted).toBe(1);
      expect(prepCalls).toHaveLength(1);
      expect(prepCalls[0]!.amountRaw).toBe("60"); // gate re-sized 100 → 60 first
      const [row] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, payoutId));
      expect(row!.status).toBe("submitted");
      expect(row!.amountRaw).toBe("60");
    } finally {
      await booted.close();
    }
  });

  it("a zero-balance sweep fails cheap WITHOUT invoking gas prep (no rental spend on doomed payouts)", async () => {
    const { booted, prepCalls, payoutId } = await bootWithGatedSource({ sourceBalance: "0" });
    try {
      await executeReservedPayouts(booted.deps);
      expect(prepCalls).toHaveLength(0);
      const [row] = await booted.deps.db.select().from(payouts).where(eq(payouts.id, payoutId));
      expect(row!.status).toBe("failed");
    } finally {
      await booted.close();
    }
  });
});
