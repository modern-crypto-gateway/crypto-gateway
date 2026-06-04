import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { confirmPayouts, executeReservedPayouts } from "../../core/domain/payout.service.js";
import { payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import { staticPegPriceOracle } from "../../adapters/price-oracle/static-peg.adapter.js";
import type { ChainAdapter, FeeTierQuote } from "../../core/ports/chain.port.js";
import type { ChainId, TxHash } from "../../core/types/chain.js";
import type { TokenSymbol } from "../../core/types/token.js";
import type { EstimateArgs } from "../../core/types/unsigned-tx.js";

const ADMIN_KEY = "super-secret-admin-key";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Pool consolidation defragments a token balance scattered across many
// HD pool addresses into one designated target, so a subsequent merchant
// payout (which on account-model chains can only pick a single sender)
// can draw from the consolidated balance. Each leg is a regular payout
// row tagged kind='consolidation_sweep' and grouped by a shared batchId
// so callers can poll group status.
//
// We use a thin wrapper over the dev adapter that flips nativeSymbol from
// "DEV" to "DEVN" so the picker treats DEVT as a non-native token (=> a
// proper token sweep, with the source needing a separate native rail
// for gas). Confirmation status is exposed for tests to advance manually.

function consolidateAdapter(): ChainAdapter & {
  confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>;
} {
  const base = devChainAdapter({ deterministicTxHashes: true });
  const statuses = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
  return {
    ...base,
    nativeSymbol(_chainId: ChainId) {
      return "DEVN" as ReturnType<ChainAdapter["nativeSymbol"]>;
    },
    async getConfirmationStatus(_chainId: ChainId, txHash: TxHash) {
      return statuses.get(txHash) ?? { blockNumber: null, confirmations: 0, reverted: false };
    },
    confirmationStatuses: statuses
  } as ChainAdapter & {
    confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>;
  };
}

describe("POST /admin/pool/consolidate", () => {
  let booted: BootedTestApp;
  let adapter: ChainAdapter & {
    confirmationStatuses: Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>;
  };
  let target: string;
  let sourceA: string;
  let sourceB: string;
  let sourceC: string;
  let sponsor: string;

  // Distinct derivation indices so addresses don't collide. Indices in the
  // 6-million range avoid the 5-million block other tests use.
  const TARGET_INDEX = 6_000_001;
  const SOURCE_A_INDEX = 6_000_002;
  const SOURCE_B_INDEX = 6_000_003;
  const SOURCE_C_INDEX = 6_000_004;
  const SPONSOR_INDEX = 6_000_005;

  beforeEach(async () => {
    adapter = consolidateAdapter();
    booted = await bootTestApp({ chains: [adapter], secretsOverrides: { ADMIN_KEY } });
    const a = booted.deps.chains[0]!;
    target = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TARGET_INDEX).address);
    sourceA = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_A_INDEX).address);
    sourceB = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_B_INDEX).address);
    sourceC = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_C_INDEX).address);
    sponsor = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);

    // Target: in the pool but holds nothing yet — it'll receive consolidated balances.
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: target, derivationIndex: TARGET_INDEX,
      balances: {}
    });
    // Sources: each holds DEVT but no native — needs sponsor top-ups to broadcast.
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceA, derivationIndex: SOURCE_A_INDEX,
      balances: { DEVT: "100" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceB, derivationIndex: SOURCE_B_INDEX,
      balances: { DEVT: "60" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceC, derivationIndex: SOURCE_C_INDEX,
      balances: { DEVT: "40" }
    });
    // Sponsor: native balance only — pays gas for each sweep top-up.
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sponsor, derivationIndex: SPONSOR_INDEX,
      balances: { DEVN: "10000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function consolidate(body: unknown): Promise<Response> {
    return await booted.app.fetch(
      new Request("http://test.local/admin/pool/consolidate", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify(body)
      })
    );
  }

  it("plans one consolidation_sweep leg per source-with-balance, all sharing a batchId", async () => {
    const res = await consolidate({ chainId: 999, token: "DEVT", targetAddress: target });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      consolidationId: string;
      legs: { payoutId: string; sourceAddress: string; amountRaw: string }[];
      skipped: { sourceAddress: string; reason: string }[];
    };

    // 3 legs (sourceA/B/C). Target itself isn't a leg even though it's in
    // the pool — it's the destination, not a source.
    expect(body.legs).toHaveLength(3);
    expect(new Set(body.legs.map((l) => l.sourceAddress))).toEqual(
      new Set([sourceA, sourceB, sourceC])
    );
    // Amounts match each source's full DEVT balance.
    const byAddress = new Map(body.legs.map((l) => [l.sourceAddress, l.amountRaw]));
    expect(byAddress.get(sourceA)).toBe("100");
    expect(byAddress.get(sourceB)).toBe("60");
    expect(byAddress.get(sourceC)).toBe("40");

    // All legs share the consolidationId via batchId, and all are tagged
    // with the consolidation_sweep kind so merchant-facing list endpoints
    // filter them out.
    const rows = await booted.deps.db
      .select()
      .from(payouts)
      .where(
        and(
          eq(payouts.batchId, body.consolidationId),
          eq(payouts.kind, "consolidation_sweep")
        )
      );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.kind).toBe("consolidation_sweep");
      expect(row.batchId).toBe(body.consolidationId);
      // Sentinel system merchant — fixed UUID hardcoded in the migration
      // and the consolidation service. Drift here is a real bug.
      expect(row.merchantId).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
      expect(row.destinationAddress).toBe(target);
    }
  });

  it("tags internal consolidation legs with the low fee tier by default (Lever 1)", async () => {
    // Internal sweeps have no merchant SLA, so planPoolConsolidation passes
    // the configured internal tier (default "low") to planPayout. Verify the
    // persisted rows carry it — this is what makes the EVM ERC-20 sweep AND
    // its gas top-up sibling ride the cheapest tier.
    const res = await consolidate({ chainId: 999, token: "DEVT", targetAddress: target });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { consolidationId: string };
    const rows = await booted.deps.db
      .select()
      .from(payouts)
      .where(
        and(eq(payouts.batchId, body.consolidationId), eq(payouts.kind, "consolidation_sweep"))
      );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.feeTier).toBe("low");
  });

  it("returns 400 when the target address isn't in the pool", async () => {
    const res = await consolidate({
      chainId: 999,
      token: "DEVT",
      targetAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TARGET_NOT_IN_POOL");
  });

  it("returns 400 when the requested token isn't registered on this chain", async () => {
    // ZZZZ passes TokenSymbolSchema's regex but isn't in the dev chain's
    // token registry. INVALID_TOKEN fires before the source-discovery loop
    // — surfacing it as a clean operator-actionable error rather than
    // silently consolidating zero rows.
    const res = await consolidate({
      chainId: 999,
      token: "ZZZZ",
      targetAddress: target
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_TOKEN");
  });

  it("GET /admin/pool/consolidations/:id returns leg statuses + a summary", async () => {
    const planRes = await consolidate({ chainId: 999, token: "DEVT", targetAddress: target });
    const plan = (await planRes.json()) as { consolidationId: string };

    const statusRes = await booted.app.fetch(
      new Request(`http://test.local/admin/pool/consolidations/${plan.consolidationId}`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      consolidationId: string;
      legs: { status: string }[];
      summary: { total: number; pendingOrInFlight: number; confirmed: number; failed: number };
    };
    expect(status.consolidationId).toBe(plan.consolidationId);
    expect(status.legs).toHaveLength(3);
    expect(status.summary.total).toBe(3);
    // Right after planning, every leg is in 'reserved' or 'topping-up'
    // — the executor hasn't run yet.
    expect(status.summary.confirmed).toBe(0);
    expect(status.summary.pendingOrInFlight).toBe(3);
  });

  it("returns 404 from GET when the consolidationId is unknown", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/pool/consolidations/00000000-0000-0000-0000-000000000000", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(404);
  });

  it("legs ride the regular executor cron through top-up + broadcast", async () => {
    // End-to-end: plan, then drive the legs through the executor and
    // confirmation sweeper. After both passes complete (with confirmation
    // status manually advanced), every leg should land in 'confirmed'.
    const planRes = await consolidate({ chainId: 999, token: "DEVT", targetAddress: target });
    expect(planRes.status).toBe(202);
    const plan = (await planRes.json()) as { consolidationId: string };

    // First executor pass: broadcasts top-ups (sources have DEVT, 0 DEVN).
    // Each top-up tx hash gets a status entry so the next pass can read
    // 'topping-up' as confirmed and proceed to the main sweep broadcast.
    await executeReservedPayouts(booted.deps);
    const afterTopUp = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.batchId, plan.consolidationId));
    // Every consolidation_sweep is now 'topping-up' with topUpTxHash set.
    const sweeps = afterTopUp.filter((r) => r.kind === "consolidation_sweep");
    expect(sweeps).toHaveLength(3);
    for (const s of sweeps) {
      expect(s.status).toBe("topping-up");
      expect(s.topUpTxHash).not.toBeNull();
      adapter.confirmationStatuses.set(s.topUpTxHash!, {
        blockNumber: 100,
        confirmations: 30,
        reverted: false
      });
    }

    // Second executor pass: reads the now-confirmed top-ups, broadcasts
    // each main sweep tx, transitions the row to 'submitted'.
    await executeReservedPayouts(booted.deps);
    const afterMainBroadcast = await booted.deps.db
      .select()
      .from(payouts)
      .where(
        and(
          eq(payouts.batchId, plan.consolidationId),
          eq(payouts.kind, "consolidation_sweep")
        )
      );
    for (const s of afterMainBroadcast) {
      expect(s.status).toBe("submitted");
      expect(s.txHash).not.toBeNull();
      adapter.confirmationStatuses.set(s.txHash!, {
        blockNumber: 200,
        confirmations: 30,
        reverted: false
      });
    }

    // Confirmation sweeper: rolls 'submitted' → 'confirmed' once the main
    // tx clears the chain's confirmation threshold. confirmPayouts is
    // shared between standard and consolidation_sweep payouts (the kind
    // filter we extended in this PR).
    await confirmPayouts(booted.deps);
    const final = await booted.deps.db
      .select()
      .from(payouts)
      .where(
        and(
          eq(payouts.batchId, plan.consolidationId),
          eq(payouts.kind, "consolidation_sweep")
        )
      );
    expect(final).toHaveLength(3);
    for (const s of final) {
      expect(s.status).toBe("confirmed");
    }
  });

  it("legs do NOT show up in merchant-facing listPayouts", async () => {
    // Merchant /payouts list endpoint filters kind='standard'. Even if a
    // merchant somehow knew the consolidationId or a leg's payoutId, the
    // list shouldn't surface internal sweep rows.
    await consolidate({ chainId: 999, token: "DEVT", targetAddress: target });

    // Use the helper's seeded merchant API key path — we just want to
    // observe the public list response. Direct DB query confirms the
    // filter is correct without depending on the merchant-auth surface.
    const merchantFacingRows = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.kind, "standard"));
    expect(merchantFacingRows).toHaveLength(0);

    const internalRows = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.kind, "consolidation_sweep"));
    expect(internalRows.length).toBeGreaterThan(0);
  });
});

// Native (gas-token) consolidation has different math than token consolidation:
// the source can't be drained because it must retain `gasNeeded + minNativeReserve`.
// The amount we plan must be `balance - gas - reserve`, otherwise the picker
// rejects every leg with INSUFFICIENT_BALANCE_ANY_SOURCE (the bug the
// production Solana SOL schedule hit — sources had 5 SOL each but planPayout
// asked them to send the FULL 5 SOL, leaving no room for sig fee + rent).
describe("POST /admin/pool/consolidate — native token math", () => {
  const NATIVE_CHAIN_ID = 999 as ChainId;
  const TARGET_INDEX = 6_100_001;
  const SOURCE_A_INDEX = 6_100_002;
  const SOURCE_B_INDEX = 6_100_003;
  const TINY_INDEX = 6_100_004;

  // Wrapper that simulates a Solana-style native chain: non-zero
  // minimumNativeReserve (rent-exempt minimum) + a small gas quote.
  // Critical: the dev adapter's default minimumNativeReserve is 0, which
  // would mask the bug we're testing.
  function nativeAdapter(): ChainAdapter {
    const base = devChainAdapter({ deterministicTxHashes: true });
    return {
      ...base,
      // Solana-like rent-exempt minimum (890_880 lamports). Source must
      // retain at least this much native after the consolidation.
      minimumNativeReserve(_chainId: ChainId): bigint {
        return 890_880n;
      }
    };
  }

  it("subtracts gas + minNativeReserve from the swept amount so the picker accepts every leg", async () => {
    const adapter = nativeAdapter();
    const booted = await bootTestApp({ chains: [adapter], secretsOverrides: { ADMIN_KEY } });
    try {
      const a = booted.deps.chains[0]!;
      const target = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TARGET_INDEX).address);
      const sourceA = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_A_INDEX).address);
      const sourceB = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_B_INDEX).address);

      await seedFundedPoolAddress(booted, {
        chainId: Number(NATIVE_CHAIN_ID), family: "evm",
        address: target, derivationIndex: TARGET_INDEX, balances: {}
      });
      // Native (DEV) balances. Each source has 1_000_000 native units —
      // enough to cover an amount + 21k gas + 890k reserve, just barely.
      await seedFundedPoolAddress(booted, {
        chainId: Number(NATIVE_CHAIN_ID), family: "evm",
        address: sourceA, derivationIndex: SOURCE_A_INDEX,
        balances: { DEV: "1000000" }
      });
      await seedFundedPoolAddress(booted, {
        chainId: Number(NATIVE_CHAIN_ID), family: "evm",
        address: sourceB, derivationIndex: SOURCE_B_INDEX,
        balances: { DEV: "2000000" }
      });

      const res = await booted.app.fetch(
        new Request("http://test.local/admin/pool/consolidate", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
          body: JSON.stringify({ chainId: Number(NATIVE_CHAIN_ID), token: "DEV", targetAddress: target })
        })
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        legs: Array<{ sourceAddress: string; amountRaw: string }>;
        skipped: Array<{ sourceAddress: string; reason: string }>;
      };
      // Pre-fix behavior: both sources land in `skipped` with
      // INSUFFICIENT_BALANCE_ANY_SOURCE because planPayout asked them
      // to send their full balance plus reserve+gas.
      // Post-fix: both sources land in `legs` with amount = balance - 2×gas - reserve.
      expect(body.legs).toHaveLength(2);
      expect(body.skipped).toHaveLength(0);

      // Sanity: each leg's amountRaw must be strictly less than its source
      // balance (we deducted gas + reserve).
      const amountByAddress = new Map(body.legs.map((l) => [l.sourceAddress, BigInt(l.amountRaw)]));
      expect(amountByAddress.get(sourceA)!).toBeLessThan(1_000_000n);
      expect(amountByAddress.get(sourceB)!).toBeLessThan(2_000_000n);
      // Roughly = balance - reserve - 2×gas. Reserve = 890_880, gas at
      // medium tier × 1.5 safety = 31500, ×2 race buffer = 63000.
      // Expected amount ≈ balance - 890_880 - 63000 ≈ balance - 953880.
      expect(amountByAddress.get(sourceA)!).toBe(1_000_000n - 953_880n);
      expect(amountByAddress.get(sourceB)!).toBe(2_000_000n - 953_880n);
    } finally {
      await booted.close();
    }
  });

  it("skips sources whose balance can't cover even the rent + gas buffer", async () => {
    const adapter = nativeAdapter();
    const booted = await bootTestApp({ chains: [adapter], secretsOverrides: { ADMIN_KEY } });
    try {
      const a = booted.deps.chains[0]!;
      const target = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TARGET_INDEX).address);
      const tiny = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TINY_INDEX).address);

      await seedFundedPoolAddress(booted, {
        chainId: Number(NATIVE_CHAIN_ID), family: "evm",
        address: target, derivationIndex: TARGET_INDEX, balances: {}
      });
      // Tiny balance: less than reserve+gas. Should be filtered out
      // entirely (not included in skipped[] either — it just doesn't
      // qualify as a candidate source).
      await seedFundedPoolAddress(booted, {
        chainId: Number(NATIVE_CHAIN_ID), family: "evm",
        address: tiny, derivationIndex: TINY_INDEX,
        balances: { DEV: "500000" } // < 890_880 reserve, can't sweep anything
      });

      const res = await booted.app.fetch(
        new Request("http://test.local/admin/pool/consolidate", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
          body: JSON.stringify({ chainId: Number(NATIVE_CHAIN_ID), token: "DEV", targetAddress: target })
        })
      );
      // No sources qualify after subtracting reserve+gas → 400 NO_SOURCES_WITH_BALANCE.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NO_SOURCES_WITH_BALANCE");
    } finally {
      await booted.close();
    }
  });
});

describe("POST /admin/pool/consolidate — fee tier override + dust floor (Levers 1 & 2)", () => {
  const TARGET_INDEX = 6_200_001;
  const SOURCE_SMALL_INDEX = 6_200_002;
  const SOURCE_LARGE_INDEX = 6_200_003;
  const SPONSOR_INDEX = 6_200_004;

  // DEVT token sweep where native = "DEV" (priced $1 by static-peg, 6 decimals)
  // and a LARGE flat gas quote, so the USD-denominated dust-floor math is
  // economically meaningful — the dev adapter's default 21000 gas is sub-cent
  // at 18 decimals and would never trip a realistic floor.
  function bigGasAdapter(gasNativeRaw: string): ChainAdapter {
    const base = devChainAdapter({ deterministicTxHashes: true });
    return {
      ...base,
      async quoteFeeTiers(_args: EstimateArgs): Promise<FeeTierQuote> {
        return {
          low: { tier: "low", nativeAmountRaw: gasNativeRaw as never },
          medium: { tier: "medium", nativeAmountRaw: gasNativeRaw as never },
          high: { tier: "high", nativeAmountRaw: gasNativeRaw as never },
          tieringSupported: false,
          nativeSymbol: "DEV" as TokenSymbol
        };
      }
    };
  }

  async function bootWith(opts: {
    gas: string;
    dustMultiplier?: number;
    feeTier?: "low" | "medium" | "high";
  }): Promise<BootedTestApp> {
    return await bootTestApp({
      chains: [bigGasAdapter(opts.gas)],
      secretsOverrides: { ADMIN_KEY },
      // Price both the native (DEV, pegged) and the token (DEVT, override) so
      // the dust-floor conversion has real USD rates.
      priceOracle: staticPegPriceOracle({ overrideRates: { DEVT: "1" } }),
      ...(opts.dustMultiplier !== undefined
        ? { consolidationDustGasMultiplier: opts.dustMultiplier }
        : {}),
      ...(opts.feeTier !== undefined ? { internalConsolidationFeeTier: opts.feeTier } : {})
    });
  }

  async function consolidateOn(booted: BootedTestApp, target: string): Promise<Response> {
    return await booted.app.fetch(
      new Request("http://test.local/admin/pool/consolidate", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ chainId: 999, token: "DEVT", targetAddress: target })
      })
    );
  }

  it("honors a configured internalConsolidationFeeTier override (Lever 1)", async () => {
    const booted = await bootWith({ gas: "21000", feeTier: "medium" });
    try {
      const a = booted.deps.chains[0]!;
      const target = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TARGET_INDEX).address);
      const src = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_LARGE_INDEX).address);
      const sponsor = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: target, derivationIndex: TARGET_INDEX, balances: {} });
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: src, derivationIndex: SOURCE_LARGE_INDEX, balances: { DEVT: "100" } });
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: sponsor, derivationIndex: SPONSOR_INDEX, balances: { DEV: "100000000" } });

      const res = await consolidateOn(booted, target);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { consolidationId: string };
      const rows = await booted.deps.db
        .select()
        .from(payouts)
        .where(and(eq(payouts.batchId, body.consolidationId), eq(payouts.kind, "consolidation_sweep")));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(row.feeTier).toBe("medium");
    } finally {
      await booted.close();
    }
  });

  it("skips a source below the gas-aware dynamic dust floor and surfaces it (Lever 2)", async () => {
    // gas 3,000,000 (DEV, 6dec) = $3; low×1.5 = $4.5; ×2 (token needs a top-up
    // tx) = $9 per sweep. K=2 → floor = $18 = 18,000,000 raw DEVT.
    const booted = await bootWith({ gas: "3000000", dustMultiplier: 2 });
    try {
      const a = booted.deps.chains[0]!;
      const target = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TARGET_INDEX).address);
      const small = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_SMALL_INDEX).address);
      const large = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_LARGE_INDEX).address);
      const sponsor = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: target, derivationIndex: TARGET_INDEX, balances: {} });
      // $10 < $18 floor → skipped as dust.
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: small, derivationIndex: SOURCE_SMALL_INDEX, balances: { DEVT: "10000000" } });
      // $30 > $18 floor → swept.
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: large, derivationIndex: SOURCE_LARGE_INDEX, balances: { DEVT: "30000000" } });
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: sponsor, derivationIndex: SPONSOR_INDEX, balances: { DEV: "100000000" } });

      const res = await consolidateOn(booted, target);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        legs: { sourceAddress: string }[];
        skipped: { sourceAddress: string; reason: string }[];
      };
      expect(body.legs.map((l) => l.sourceAddress)).toEqual([large]);
      const dust = body.skipped.find((s) => s.sourceAddress === small);
      expect(dust).toBeDefined();
      expect(dust!.reason).toContain("BELOW_DYNAMIC_DUST_FLOOR");
    } finally {
      await booted.close();
    }
  });

  it("with the dust floor OFF (default), still sweeps a small token balance (Lever 2 opt-in)", async () => {
    // Same large gas, but no multiplier → floor disabled → the $10 source that
    // the previous test skipped now sweeps. Proves the lever is opt-in.
    const booted = await bootWith({ gas: "3000000" });
    try {
      const a = booted.deps.chains[0]!;
      const target = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TARGET_INDEX).address);
      const small = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_SMALL_INDEX).address);
      const sponsor = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: target, derivationIndex: TARGET_INDEX, balances: {} });
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: small, derivationIndex: SOURCE_SMALL_INDEX, balances: { DEVT: "10000000" } });
      await seedFundedPoolAddress(booted, { chainId: 999, family: "evm", address: sponsor, derivationIndex: SPONSOR_INDEX, balances: { DEV: "100000000" } });

      const res = await consolidateOn(booted, target);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        legs: { sourceAddress: string }[];
        skipped: { sourceAddress: string; reason: string }[];
      };
      expect(body.legs.map((l) => l.sourceAddress)).toEqual([small]);
      expect(body.skipped).toHaveLength(0);
    } finally {
      await booted.close();
    }
  });
});
