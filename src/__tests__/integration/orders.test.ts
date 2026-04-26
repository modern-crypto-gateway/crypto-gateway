import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

describe("POST /api/v1/invoices", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp();
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("creates an invoice with an HD-derived receive address", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1000000" })
      })
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { invoice: Record<string, unknown> };
    expect(body.invoice).toMatchObject({
      merchantId: MERCHANT_ID,
      chainId: 999,
      token: "DEV",
      status: "pending",
      extraStatus: null,
      requiredAmountRaw: "1000000",
      receivedAmountRaw: "0",
      addressIndex: 0
    });
    expect(body.invoice["id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.invoice["receiveAddress"]).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("converts a fiat amount via the price oracle (1:1 for DEV)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", fiatAmount: "12.50", fiatCurrency: "USD" })
      })
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { invoice: Record<string, unknown> };
    expect(body.invoice["requiredAmountRaw"]).toBe("12500000");
    expect(body.invoice["quotedRate"]).toBe("1");
    expect(body.invoice["fiatAmount"]).toBe("12.50");
    expect(body.invoice["fiatCurrency"]).toBe("USD");
  });

  it("allocates a new HD index for each invoice on the same chain", async () => {
    const body = { chainId: 999, token: "DEV", amountRaw: "1" };
    const make = () =>
      booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: authHeader(apiKey),
          body: JSON.stringify(body)
        })
      );

    const r1 = (await (await make()).json()) as { invoice: { addressIndex: number; receiveAddress: string } };
    const r2 = (await (await make()).json()) as { invoice: { addressIndex: number; receiveAddress: string } };

    expect(r1.invoice.addressIndex).toBe(0);
    expect(r2.invoice.addressIndex).toBe(1);
    expect(r1.invoice.receiveAddress).not.toBe(r2.invoice.receiveAddress);
  });

  it("rejects requests without an API key (401)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
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
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader("sk_bogus"),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects unsupported token with 400", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "USDC", amountRaw: "1" })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TOKEN_NOT_SUPPORTED");
  });

  it("round-trips: GET /:id returns the created invoice", async () => {
    const createRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "42" })
      })
    );
    const created = (await createRes.json()) as { invoice: { id: string } };

    const getRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/invoices/${created.invoice.id}`, { headers: authHeader(apiKey) })
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { invoice: { id: string; requiredAmountRaw: string } };
    expect(fetched.invoice.id).toBe(created.invoice.id);
    expect(fetched.invoice.requiredAmountRaw).toBe("42");
  });

  it("GET /:id returns 404 for another merchant's invoice (no cross-merchant access)", async () => {
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
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: authHeader(ownerKey),
          body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
        })
      );
      const created = (await createRes.json()) as { invoice: { id: string } };

      const res = await otherBooted.app.fetch(
        new Request(`http://test.local/api/v1/invoices/${created.invoice.id}`, { headers: authHeader(intruderKey) })
      );
      expect(res.status).toBe(404);
    } finally {
      await otherBooted.close();
    }
  });

  it("POST /:id/expire transitions a created invoice to expired and emits invoice.expired", async () => {
    const events: string[] = [];
    booted.deps.events.subscribeAll((e) => { events.push(e.type); });

    const createRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    const created = (await createRes.json()) as { invoice: { id: string } };

    const expireRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/invoices/${created.invoice.id}/expire`, {
        method: "POST",
        headers: authHeader(apiKey)
      })
    );
    expect(expireRes.status).toBe(200);
    const expired = (await expireRes.json()) as { invoice: { status: string } };
    expect(expired.invoice.status).toBe("expired");

    expect(events).toEqual(["invoice.created", "invoice.expired"]);
  });

  it("returns the existing invoice when externalId is reused (Stripe-style idempotency)", async () => {
    // Background: prior to this behavior, retrying a POST with the same
    // `externalId` (typical: merchant's order ID) hit the partial unique index
    // `uq_invoices_external_id (merchant_id, external_id)` and surfaced as a
    // 500. Now we return the original invoice — same id, same address, same
    // amounts — and never touch the address pool a second time.
    const body = JSON.stringify({
      chainId: 999,
      token: "DEV",
      amountRaw: "1000000",
      externalId: "order-12345"
    });
    const first = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body
      })
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } };

    const second = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body
      })
    );
    // 200 when returning an existing resource (the route layer maps creation
    // -> 201; idempotent return is the same code today, but the body equality
    // is what merchants depend on).
    expect([200, 201]).toContain(second.status);
    const secondBody = (await second.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } };

    expect(secondBody.invoice.id).toBe(firstBody.invoice.id);
    expect(secondBody.invoice.receiveAddress).toBe(firstBody.invoice.receiveAddress);
    expect(secondBody.invoice.addressIndex).toBe(firstBody.invoice.addressIndex);

    // Pool wasn't burned by the duplicate: the next NEW invoice (different
    // externalId) still gets index 1, not index 2.
    const third = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 999,
          token: "DEV",
          amountRaw: "1000000",
          externalId: "order-67890"
        })
      })
    );
    expect(third.status).toBe(201);
    const thirdBody = (await third.json()) as { invoice: { addressIndex: number } };
    expect(thirdBody.invoice.addressIndex).toBe(1);
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
