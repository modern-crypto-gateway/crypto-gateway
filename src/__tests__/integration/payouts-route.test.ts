import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

describe("POST /api/v1/payouts", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("creates a planned payout and canonicalizes the destination", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountRaw: "500",
          destinationAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payout: Record<string, unknown> };
    expect(body.payout).toMatchObject({
      merchantId: MERCHANT_ID,
      status: "planned",
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
  });

  it("rejects unauth'd payout requests with 401", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
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

  it("amount (decimal) input converts to amountRaw via BigInt against token decimals", async () => {
    // DEV has 6 decimals, so "1.5" → 1.5 * 10^6 = 1500000.
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amount: "1.5",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payout: Record<string, unknown> };
    expect(body.payout["amountRaw"]).toBe("1500000");
    // Decimal/raw paths leave the USD audit columns null.
    expect(body.payout["quotedAmountUsd"]).toBeNull();
    expect(body.payout["quotedRate"]).toBeNull();
  });

  it("amountUSD input snapshots quotedAmountUsd + quotedRate via the price oracle", async () => {
    // DEV is pegged at $1 in the static-peg oracle, 6 decimals → "10" USD = 10000000 raw.
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountUSD: "10",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payout: Record<string, unknown> };
    expect(body.payout["amountRaw"]).toBe("10000000");
    expect(body.payout["quotedAmountUsd"]).toBe("10");
    // Static-peg returns the configured rate string ($1 for DEV).
    expect(body.payout["quotedRate"]).toBe("1");
  });

  it("rejects requests that supply more than one amount key with 400", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountRaw: "500",
          amountUSD: "10",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects requests that supply zero amount keys with 400", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects amount with more decimal places than the token allows (BAD_AMOUNT)", async () => {
    // DEV has 6 decimals; "1.1234567" has 7 → reject.
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amount: "1.1234567",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_AMOUNT");
  });

  it("amountUSD fails with 503 ORACLE_FAILED when the price oracle throws", async () => {
    const failingOracle = {
      tokenToFiat: async () => {
        throw new Error("oracle is down");
      },
      fiatToTokenAmount: async () => {
        throw new Error("oracle is down");
      },
      getUsdRates: async () => ({})
    };
    const failingBoot = await bootTestApp({ priceOracle: failingOracle });
    try {
      const failingApiKey = failingBoot.apiKeys[MERCHANT_ID]!;
      const res = await failingBoot.app.fetch(
        new Request("http://test.local/api/v1/payouts", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${failingApiKey}` },
          body: JSON.stringify({
            chainId: 999,
            token: "DEV",
            amountUSD: "10",
            destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          })
        })
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("ORACLE_FAILED");
    } finally {
      await failingBoot.close();
    }
  });

  it("rejects an invalid destination address with 400", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountRaw: "1",
          destinationAddress: "not-an-address"
        })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_DESTINATION");
  });

  it("GET /:id returns the planned payout to its owning merchant", async () => {
    const createRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountRaw: "500",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
      })
    );
    const { payout } = (await createRes.json()) as { payout: { id: string } };
    const getRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/payouts/${payout.id}`, {
        headers: { authorization: `Bearer ${apiKey}` }
      })
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { payout: { id: string; status: string } };
    expect(fetched.payout.id).toBe(payout.id);
    expect(fetched.payout.status).toBe("planned");
  });

  it("GET /:id returns 404 when another merchant's key is used", async () => {
    const twoMerchants = await bootTestApp({
      merchants: [
        { id: MERCHANT_ID, name: "Owner" },
        { id: "00000000-0000-0000-0000-000000000002", name: "Intruder" }
      ]
    });
    try {
      const ownerKey = twoMerchants.apiKeys[MERCHANT_ID]!;
      const intruderKey = twoMerchants.apiKeys["00000000-0000-0000-0000-000000000002"]!;

      const createRes = await twoMerchants.app.fetch(
        new Request("http://test.local/api/v1/payouts", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
          body: JSON.stringify({
            chainId: 999,
            token: "DEV",
            amountRaw: "1",
            destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          })
        })
      );
      const { payout } = (await createRes.json()) as { payout: { id: string } };

      const res = await twoMerchants.app.fetch(
        new Request(`http://test.local/api/v1/payouts/${payout.id}`, {
          headers: { authorization: `Bearer ${intruderKey}` }
        })
      );
      expect(res.status).toBe(404);
    } finally {
      await twoMerchants.close();
    }
  });
});
