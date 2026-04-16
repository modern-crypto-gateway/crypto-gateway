import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

describe("POST /api/v1/orders", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("creates an order with an HD-derived receive address", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/orders", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1000000" })
      })
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { order: Record<string, unknown> };
    expect(body.order).toMatchObject({
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      status: "created",
      requiredAmountRaw: "1000000",
      receivedAmountRaw: "0",
      addressIndex: 0
    });
    expect(body.order["id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.order["receiveAddress"]).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("converts a fiat amount via the price oracle (1:1 for DEV)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/orders", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", fiatAmount: "12.50", fiatCurrency: "USD" })
      })
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { order: Record<string, unknown> };
    expect(body.order["requiredAmountRaw"]).toBe("12500000");
    expect(body.order["quotedRate"]).toBe("1");
    expect(body.order["fiatAmount"]).toBe("12.50");
    expect(body.order["fiatCurrency"]).toBe("USD");
  });

  it("allocates a new HD index for each order on the same chain", async () => {
    const body = { chainId: 999, token: "DEV", amountRaw: "1" };
    const make = () =>
      booted.app.fetch(
        new Request("http://test.local/api/v1/orders", {
          method: "POST",
          headers: authHeader(apiKey),
          body: JSON.stringify(body)
        })
      );

    const r1 = (await (await make()).json()) as { order: { addressIndex: number; receiveAddress: string } };
    const r2 = (await (await make()).json()) as { order: { addressIndex: number; receiveAddress: string } };

    expect(r1.order.addressIndex).toBe(0);
    expect(r2.order.addressIndex).toBe(1);
    expect(r1.order.receiveAddress).not.toBe(r2.order.receiveAddress);
  });

  it("rejects requests without an API key (401)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects requests with a bogus API key (401)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/orders", {
        method: "POST",
        headers: authHeader("sk_bogus"),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects unsupported token with 400", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/orders", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "USDC", amountRaw: "1" })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TOKEN_NOT_SUPPORTED");
  });

  it("round-trips: GET /:id returns the created order", async () => {
    const createRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/orders", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "42" })
      })
    );
    const created = (await createRes.json()) as { order: { id: string } };

    const getRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/orders/${created.order.id}`, { headers: authHeader(apiKey) })
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { order: { id: string; requiredAmountRaw: string } };
    expect(fetched.order.id).toBe(created.order.id);
    expect(fetched.order.requiredAmountRaw).toBe("42");
  });

  it("GET /:id returns 404 for another merchant's order (no cross-merchant access)", async () => {
    const otherBooted = await bootTestApp({
      merchants: [
        { id: MERCHANT_ID, name: "Owner" },
        { id: "00000000-0000-0000-0000-000000000002", name: "Intruder" }
      ]
    });
    try {
      const ownerKey = otherBooted.apiKeys[MERCHANT_ID]!;
      const intruderKey = otherBooted.apiKeys["00000000-0000-0000-0000-000000000002"]!;

      const createRes = await otherBooted.app.fetch(
        new Request("http://test.local/api/v1/orders", {
          method: "POST",
          headers: authHeader(ownerKey),
          body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
        })
      );
      const created = (await createRes.json()) as { order: { id: string } };

      const res = await otherBooted.app.fetch(
        new Request(`http://test.local/api/v1/orders/${created.order.id}`, { headers: authHeader(intruderKey) })
      );
      expect(res.status).toBe(404);
    } finally {
      await otherBooted.close();
    }
  });

  it("POST /:id/expire transitions a created order to expired and emits order.expired", async () => {
    const events: string[] = [];
    booted.deps.events.subscribeAll((e) => { events.push(e.type); });

    const createRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/orders", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    const created = (await createRes.json()) as { order: { id: string } };

    const expireRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/orders/${created.order.id}/expire`, {
        method: "POST",
        headers: authHeader(apiKey)
      })
    );
    expect(expireRes.status).toBe(200);
    const expired = (await expireRes.json()) as { order: { status: string } };
    expect(expired.order.status).toBe("expired");

    expect(events).toEqual(["order.created", "order.expired"]);
  });
});

describe("GET /health", () => {
  it("returns phase marker", async () => {
    const booted = await bootTestApp();
    try {
      const res = await booted.app.fetch(new Request("http://test.local/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; phase: number };
      expect(body).toEqual({ status: "ok", phase: 8 });
    } finally {
      await booted.close();
    }
  });
});
