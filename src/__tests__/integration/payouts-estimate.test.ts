import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import type { ChainAdapter } from "../../core/ports/chain.port.js";
import type { Address, ChainId } from "../../core/types/chain.js";
import type { TokenSymbol } from "../../core/types/token.js";

const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

describe("POST /api/v1/payouts/estimate", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  async function estimate(body: unknown): Promise<Response> {
    return booted.app.fetch(
      new Request("http://test.local/api/v1/payouts/estimate", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      })
    );
  }

  it("returns three tiers + USD conversion + the resolved amountRaw", async () => {
    const res = await estimate({
      chainId: 999,
      token: "DEV",
      amountRaw: "1000",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      amountRaw: string;
      tiers: {
        tieringSupported: boolean;
        nativeSymbol: string;
        low: { tier: "low"; nativeAmountRaw: string; usdAmount: string | null };
        medium: { tier: "medium"; nativeAmountRaw: string; usdAmount: string | null };
        high: { tier: "high"; nativeAmountRaw: string; usdAmount: string | null };
      };
    };
    expect(body.amountRaw).toBe("1000");
    expect(body.tiers.nativeSymbol).toBe("DEV");
    // Dev adapter returns "21000" for estimateGasForTransfer — same value
    // across all tiers since dev's quoteFeeTiers returns identical amounts.
    expect(body.tiers.low.nativeAmountRaw).toBe("21000");
    expect(body.tiers.medium.nativeAmountRaw).toBe("21000");
    expect(body.tiers.high.nativeAmountRaw).toBe("21000");
    expect(body.tiers.tieringSupported).toBe(false);
    // Static-peg quotes DEV at $1, so 21000 raw with 6 decimals = 0.021 DEV
    // = $0.02 (rounded to 2 places).
    expect(body.tiers.medium.usdAmount).toBe("0.02");
  });

  it("resolves amountUSD via the price oracle and echoes the snapshot", async () => {
    const res = await estimate({
      chainId: 999,
      token: "DEV",
      amountUSD: "10",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      amountRaw: string;
      quotedAmountUsd: string | null;
      quotedRate: string | null;
    };
    // DEV is pegged at $1 in static-peg, 6 decimals → $10 = 10000000 raw.
    expect(body.amountRaw).toBe("10000000");
    expect(body.quotedAmountUsd).toBe("10");
    expect(body.quotedRate).toBe("1");
  });

  it("rejects requests for unsupported tokens with 400 TOKEN_NOT_SUPPORTED", async () => {
    const res = await estimate({
      chainId: 999,
      token: "USDC", // not registered on chainId 999
      amountRaw: "1",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TOKEN_NOT_SUPPORTED");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountRaw: "1",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      })
    );
    expect(res.status).toBe(401);
  });

  it("plan with feeTier persists the tier on the row for executor binding", async () => {
    // planPayout now selects a source synchronously — seed one.
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const idx = 600_001;
    const { address } = adapter.deriveAddress(TEST_MASTER_SEED, idx);
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: adapter.canonicalizeAddress(address),
      derivationIndex: idx,
      balances: { DEV: "1000000000000000000" }
    });
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountRaw: "100",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          feeTier: "high"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payout: { id: string; feeTier: string | null } };
    expect(body.payout.feeTier).toBe("high");

    // DB confirms — the executor will read this column at broadcast time and
    // pass it into adapter.buildTransfer for fee-binding.
    const [row] = await booted.deps.db
      .select({ feeTier: payouts.feeTier })
      .from(payouts)
      .where(eq(payouts.id, body.payout.id))
      .limit(1);
    expect(row?.feeTier).toBe("high");
  });

  it("returns null `source` + actionable warning when no HD source has enough balance", async () => {
    // Fresh boot — no funded pool addresses. The estimate should still
    // return a valid tier quote with an operator-facing warning the
    // dashboard renders instead of a raw error toast.
    const res = await estimate({
      chainId: 999,
      token: "DEV",
      amountRaw: "1000",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tiers: { low: { nativeAmountRaw: string } };
      source: unknown;
      alternatives: unknown[];
      warnings: string[];
    };
    expect(body.source).toBeNull();
    expect(body.warnings).toContain("no_source_address_has_sufficient_token_balance");
    expect(typeof body.tiers.low.nativeAmountRaw).toBe("string");
  });

});

// `feeCoveredByDelegatedEnergy` lets the frontend show "$0 — covered by
// delegated energy" for Tron sources that have enough delegated energy,
// instead of the chain-level worst-case `tiers` figure (~20 TRX). The
// chain-level tiers can't know which source will be picked, so on Tron
// they always quote the burn-all-SUN worst case.
describe("POST /api/v1/payouts/estimate — delegated-energy fee flag", () => {
  // Wrapper: dev adapter (family 'evm') with a `hasSufficientFreeGas`
  // probe that returns true for one specific address. Mirrors how Tron's
  // adapter reports delegated-energy coverage. nativeSymbol stays "DEV"
  // so DEVT is treated as a non-native token (free-gas only applies to
  // token payouts — gas IS the asset for native).
  function freeGasAdapter(freeAddress: string): ChainAdapter {
    const base = devChainAdapter({ deterministicTxHashes: true });
    return {
      ...base,
      async hasSufficientFreeGas(args: {
        readonly chainId: ChainId;
        readonly address: Address;
        readonly token: TokenSymbol;
      }): Promise<boolean> {
        return args.address.toLowerCase() === freeAddress.toLowerCase();
      }
    };
  }

  it("sets feeCoveredByDelegatedEnergy=true on a source with delegated energy, false on others", async () => {
    const TEST_SEED = "test test test test test test test test test test test junk";
    // Pre-derive two addresses; the first is the one with delegated energy.
    const probe = devChainAdapter({ deterministicTxHashes: true });
    const delegatedAddr = probe.canonicalizeAddress(probe.deriveAddress(TEST_SEED, 610_001).address);
    const plainAddr = probe.canonicalizeAddress(probe.deriveAddress(TEST_SEED, 610_002).address);

    const booted2 = await bootTestApp({
      chains: [freeGasAdapter(delegatedAddr)],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      // Both sources hold the DEVT token; NEITHER holds native (DEV).
      // The delegated-energy source still qualifies as a Tier-A direct
      // pick (free-gas override), and its candidate must carry the flag.
      await seedFundedPoolAddress(booted2, {
        chainId: 999, family: "evm", address: delegatedAddr, derivationIndex: 610_001,
        balances: { DEVT: "1000000000" }
      });
      await seedFundedPoolAddress(booted2, {
        chainId: 999, family: "evm", address: plainAddr, derivationIndex: 610_002,
        balances: { DEVT: "500000000" }
      });

      const res = await booted2.app.fetch(
        new Request("http://test.local/api/v1/payouts/estimate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${booted2.apiKeys[MERCHANT_ID]!}`
          },
          body: JSON.stringify({
            chainId: 999,
            token: "DEVT",
            amountRaw: "100000000",
            destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          })
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        source: { address: string; feeCoveredByDelegatedEnergy: boolean } | null;
        alternatives: Array<{ address: string; feeCoveredByDelegatedEnergy: boolean }>;
      };

      // Picker is richest-first → delegatedAddr (1000 DEVT) is the source.
      expect(body.source).not.toBeNull();
      expect(body.source!.address.toLowerCase()).toBe(delegatedAddr.toLowerCase());
      // It has delegated energy → flagged. Frontend renders "$0".
      expect(body.source!.feeCoveredByDelegatedEnergy).toBe(true);

      // plainAddr is an alternative and does NOT have delegated energy.
      const plainAlt = body.alternatives.find(
        (a) => a.address.toLowerCase() === plainAddr.toLowerCase()
      );
      expect(plainAlt).toBeDefined();
      expect(plainAlt!.feeCoveredByDelegatedEnergy).toBe(false);
    } finally {
      await booted2.close();
    }
  });
});
