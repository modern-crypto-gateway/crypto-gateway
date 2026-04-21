import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";

const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const GOOD_DEST = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("POST /api/v1/payouts/batch", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
    // planPayout (and therefore planPayoutBatch) requires a funded HD
    // source for each row. Seed one with comfortably more than 100 rows'
    // worth of DEV so the batch tests don't hit INSUFFICIENT_BALANCE_ANY_SOURCE.
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const idx = 700_001;
    const { address } = adapter.deriveAddress(TEST_MASTER_SEED, idx);
    await seedFundedPoolAddress(booted, {
      chainId: 999,
      family: "evm",
      address: adapter.canonicalizeAddress(address),
      derivationIndex: idx,
      balances: { DEV: "1000000000000000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function batch(body: unknown): Promise<Response> {
    return booted.app.fetch(
      new Request("http://test.local/api/v1/payouts/batch", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      })
    );
  }

  it("plans all valid rows in one call and attaches a shared batchId", async () => {
    const res = await batch({
      payouts: [
        { chainId: 999, token: "DEV", amountRaw: "100", destinationAddress: GOOD_DEST },
        { chainId: 999, token: "DEV", amountRaw: "200", destinationAddress: GOOD_DEST },
        { chainId: 999, token: "DEV", amountRaw: "300", destinationAddress: GOOD_DEST }
      ]
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      batchId: string;
      results: Array<{
        index: number;
        status: "planned" | "failed";
        payout?: { id: string; batchId: string | null; amountRaw: string };
      }>;
      summary: { planned: number; failed: number };
    };
    expect(body.summary.planned).toBe(3);
    expect(body.summary.failed).toBe(0);
    expect(body.batchId.length).toBeGreaterThan(0);

    // Every planned row carries the same batchId, and it matches the top-level field.
    const batchIdsOnRows = body.results
      .filter((r) => r.status === "planned")
      .map((r) => r.payout!.batchId);
    expect(new Set(batchIdsOnRows).size).toBe(1);
    expect(batchIdsOnRows[0]).toBe(body.batchId);

    // DB confirms all three rows have the same batchId.
    const dbRows = await booted.deps.db
      .select({ batchId: payouts.batchId })
      .from(payouts)
      .where(eq(payouts.batchId, body.batchId));
    expect(dbRows).toHaveLength(3);
  });

  it("partial success: valid rows plan, bad rows report per-row errors, HTTP 200 overall", async () => {
    const res = await batch({
      payouts: [
        { chainId: 999, token: "DEV", amountRaw: "100", destinationAddress: GOOD_DEST },
        // Wrong-token row: DEV chain doesn't have USDC registered.
        { chainId: 999, token: "USDC", amountRaw: "100", destinationAddress: GOOD_DEST },
        // Bad destination address.
        { chainId: 999, token: "DEV", amountRaw: "100", destinationAddress: "not-an-address" },
        { chainId: 999, token: "DEV", amountRaw: "200", destinationAddress: GOOD_DEST }
      ]
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ index: number; status: string; error?: { code: string } }>;
      summary: { planned: number; failed: number };
    };
    expect(body.summary).toEqual({ planned: 2, failed: 2 });

    const byIndex = Object.fromEntries(body.results.map((r) => [r.index, r]));
    expect(byIndex[0]!.status).toBe("planned");
    expect(byIndex[1]!.status).toBe("failed");
    expect(byIndex[1]!.error!.code).toBe("TOKEN_NOT_SUPPORTED");
    expect(byIndex[2]!.status).toBe("failed");
    expect(byIndex[2]!.error!.code).toBe("INVALID_DESTINATION");
    expect(byIndex[3]!.status).toBe("planned");
  });

  it("rejects a batch exceeding the per-request cap (100) with BATCH_TOO_LARGE", async () => {
    const oversize = Array.from({ length: 101 }, () => ({
      chainId: 999,
      token: "DEV",
      amountRaw: "1",
      destinationAddress: GOOD_DEST
    }));
    const res = await batch({ payouts: oversize });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BATCH_TOO_LARGE");
  });

  it("400s on a body missing the `payouts` array", async () => {
    const res = await batch({ not_the_key: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_JSON");
  });

  it("401s without auth", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payouts: [] })
      })
    );
    expect(res.status).toBe(401);
  });

  it("list filter ?batchId=... returns only rows from that batch", async () => {
    // Create two batches; ensure the list filter isolates them.
    const b1 = await batch({
      payouts: [
        { chainId: 999, token: "DEV", amountRaw: "10", destinationAddress: GOOD_DEST },
        { chainId: 999, token: "DEV", amountRaw: "20", destinationAddress: GOOD_DEST }
      ]
    });
    const b1Body = (await b1.json()) as { batchId: string };

    await batch({
      payouts: [{ chainId: 999, token: "DEV", amountRaw: "999", destinationAddress: GOOD_DEST }]
    });

    const res = await booted.app.fetch(
      new Request(`http://test.local/api/v1/payouts?batchId=${b1Body.batchId}`, {
        headers: { authorization: `Bearer ${apiKey}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payouts: Array<{ batchId: string; amountRaw: string }> };
    expect(body.payouts).toHaveLength(2);
    expect(body.payouts.every((p) => p.batchId === b1Body.batchId)).toBe(true);
    // The single-row batch is correctly NOT returned.
    expect(body.payouts.some((p) => p.amountRaw === "999")).toBe(false);
  });
});
