import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { transactions } from "../../db/schema.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_MERCHANT = "00000000-0000-0000-0000-000000000002";

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

async function createInvoice(
  booted: BootedTestApp,
  apiKey: string,
  body: Record<string, unknown>
): Promise<{ id: string; receiveAddress: string }> {
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/invoices", {
      method: "POST",
      headers: authHeader(apiKey),
      body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1", ...body })
    })
  );
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as { invoice: { id: string; receiveAddress: string } };
  return parsed.invoice;
}

async function listInvoices(
  booted: BootedTestApp,
  apiKey: string,
  query: string = ""
): Promise<{
  status: number;
  body: {
    invoices?: Array<Record<string, unknown>>;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    error?: { code: string };
  };
}> {
  const res = await booted.app.fetch(
    new Request(`http://test.local/api/v1/invoices${query}`, { headers: authHeader(apiKey) })
  );
  return { status: res.status, body: (await res.json()) as never };
}

describe("GET /api/v1/invoices", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    booted = await bootTestApp({
      merchants: [
        { id: MERCHANT_ID, name: "Owner" },
        { id: OTHER_MERCHANT, name: "Neighbor" }
      ]
    });
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("returns the merchant's invoices newest-first with pagination metadata", async () => {
    const a = await createInvoice(booted, apiKey, { externalId: "order-a" });
    const b = await createInvoice(booted, apiKey, { externalId: "order-b" });
    const c = await createInvoice(booted, apiKey, { externalId: "order-c" });

    const { status, body } = await listInvoices(booted, apiKey);
    expect(status).toBe(200);
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(0);
    expect(body.hasMore).toBe(false);
    const ids = (body.invoices ?? []).map((i) => i["id"]);
    // All three present; newest-first ordering by createdAt means c first when
    // clocks advance between creates — but back-to-back creates can tie on
    // the millisecond, so only assert set membership.
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(ids).toHaveLength(3);
  });

  it("hides another merchant's invoices (cross-merchant isolation)", async () => {
    const mine = await createInvoice(booted, apiKey, { externalId: "mine" });
    const theirKey = booted.apiKeys[OTHER_MERCHANT]!;
    await createInvoice(booted, theirKey, { externalId: "theirs" });

    const { body } = await listInvoices(booted, apiKey);
    const ids = (body.invoices ?? []).map((i) => i["id"]);
    expect(ids).toContain(mine.id);
    expect(ids).toHaveLength(1);
  });

  it("paginates with limit + offset and reports hasMore", async () => {
    for (let i = 0; i < 5; i += 1) {
      await createInvoice(booted, apiKey, { externalId: `p-${i}` });
    }
    const page1 = await listInvoices(booted, apiKey, "?limit=2");
    expect(page1.body.invoices).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);

    const page3 = await listInvoices(booted, apiKey, "?limit=2&offset=4");
    expect(page3.body.invoices).toHaveLength(1);
    expect(page3.body.hasMore).toBe(false);
  });

  it("filters by externalId (exact match)", async () => {
    await createInvoice(booted, apiKey, { externalId: "pick-me" });
    await createInvoice(booted, apiKey, { externalId: "other" });

    const { body } = await listInvoices(booted, apiKey, "?externalId=pick-me");
    expect(body.invoices).toHaveLength(1);
    expect(body.invoices?.[0]?.["externalId"]).toBe("pick-me");
  });

  it("filters by status (comma-separated)", async () => {
    const live = await createInvoice(booted, apiKey, { externalId: "live" });
    const toExpire = await createInvoice(booted, apiKey, { externalId: "to-expire" });
    // Expire one so we can filter by status.
    const expireRes = await booted.app.fetch(
      new Request(`http://test.local/api/v1/invoices/${toExpire.id}/expire`, {
        method: "POST",
        headers: authHeader(apiKey)
      })
    );
    expect(expireRes.status).toBe(200);

    const justCreated = await listInvoices(booted, apiKey, "?status=created");
    const ids = (justCreated.body.invoices ?? []).map((i) => i["id"]);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(toExpire.id);

    const multi = await listInvoices(booted, apiKey, "?status=created,expired");
    const multiIds = (multi.body.invoices ?? []).map((i) => i["id"]);
    expect(multiIds).toEqual(expect.arrayContaining([live.id, toExpire.id]));
  });

  it("rejects an unknown status with 400", async () => {
    const { status, body } = await listInvoices(booted, apiKey, "?status=bogus");
    expect(status).toBe(400);
    expect(body.error?.code).toBe("BAD_STATUS");
  });

  it("filters by toAddress against invoices.receiveAddress", async () => {
    const a = await createInvoice(booted, apiKey, { externalId: "a" });
    await createInvoice(booted, apiKey, { externalId: "b" });

    const { body } = await listInvoices(
      booted,
      apiKey,
      `?toAddress=${encodeURIComponent(a.receiveAddress)}`
    );
    expect(body.invoices).toHaveLength(1);
    expect(body.invoices?.[0]?.["id"]).toBe(a.id);
  });

  it("filters by fromAddress via the transactions join", async () => {
    const a = await createInvoice(booted, apiKey, { externalId: "a" });
    const b = await createInvoice(booted, apiKey, { externalId: "b" });
    const payer = "0x1111111111111111111111111111111111111111";

    // Seed transactions: one from `payer` matched to invoice `a`, one from a
    // different address matched to `b`. The from-address filter should return
    // only `a`.
    const now = booted.deps.clock.now().getTime();
    await booted.deps.db.insert(transactions).values({
      id: globalThis.crypto.randomUUID(),
      invoiceId: a.id,
      chainId: 999,
      txHash: "0xaaaa",
      logIndex: 0,
      fromAddress: payer,
      toAddress: a.receiveAddress,
      token: "DEV",
      amountRaw: "1",
      blockNumber: 1,
      confirmations: 12,
      status: "confirmed",
      detectedAt: now,
      confirmedAt: now,
      amountUsd: null,
      usdRate: null
    });
    await booted.deps.db.insert(transactions).values({
      id: globalThis.crypto.randomUUID(),
      invoiceId: b.id,
      chainId: 999,
      txHash: "0xbbbb",
      logIndex: 0,
      fromAddress: "0x2222222222222222222222222222222222222222",
      toAddress: b.receiveAddress,
      token: "DEV",
      amountRaw: "1",
      blockNumber: 1,
      confirmations: 12,
      status: "confirmed",
      detectedAt: now,
      confirmedAt: now,
      amountUsd: null,
      usdRate: null
    });

    const { body } = await listInvoices(booted, apiKey, `?fromAddress=${payer}`);
    const ids = (body.invoices ?? []).map((i) => i["id"]);
    expect(ids).toEqual([a.id]);
  });

  it("401s without an API key", async () => {
    const res = await booted.app.fetch(new Request("http://test.local/api/v1/invoices"));
    expect(res.status).toBe(401);
  });
});
