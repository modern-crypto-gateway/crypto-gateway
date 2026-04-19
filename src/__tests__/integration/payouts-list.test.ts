import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_MERCHANT = "00000000-0000-0000-0000-000000000002";

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

async function planPayout(
  booted: BootedTestApp,
  apiKey: string,
  body: Record<string, unknown>
): Promise<{ id: string; destinationAddress: string }> {
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/payouts", {
      method: "POST",
      headers: authHeader(apiKey),
      body: JSON.stringify({
        chainId: 999,
        token: "DEV",
        amountRaw: "1",
        destinationAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ...body
      })
    })
  );
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as {
    payout: { id: string; destinationAddress: string };
  };
  return parsed.payout;
}

async function listPayouts(
  booted: BootedTestApp,
  apiKey: string,
  query: string = ""
): Promise<{
  status: number;
  body: {
    payouts?: Array<Record<string, unknown>>;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    error?: { code: string };
  };
}> {
  const res = await booted.app.fetch(
    new Request(`http://test.local/api/v1/payouts${query}`, { headers: authHeader(apiKey) })
  );
  return { status: res.status, body: (await res.json()) as never };
}

describe("GET /api/v1/payouts", () => {
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

  it("returns the merchant's payouts with pagination metadata", async () => {
    const a = await planPayout(booted, apiKey, {
      destinationAddress: "0x1111111111111111111111111111111111111111"
    });
    const b = await planPayout(booted, apiKey, {
      destinationAddress: "0x2222222222222222222222222222222222222222"
    });

    const { status, body } = await listPayouts(booted, apiKey);
    expect(status).toBe(200);
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(0);
    expect(body.hasMore).toBe(false);
    const ids = (body.payouts ?? []).map((p) => p["id"]);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).toHaveLength(2);
  });

  it("hides another merchant's payouts", async () => {
    const mine = await planPayout(booted, apiKey, {});
    const theirKey = booted.apiKeys[OTHER_MERCHANT]!;
    await planPayout(booted, theirKey, {});

    const { body } = await listPayouts(booted, apiKey);
    const ids = (body.payouts ?? []).map((p) => p["id"]);
    expect(ids).toContain(mine.id);
    expect(ids).toHaveLength(1);
  });

  it("filters by destinationAddress (canonicalized)", async () => {
    const target = "0xcccccccccccccccccccccccccccccccccccccccc";
    const a = await planPayout(booted, apiKey, { destinationAddress: target });
    await planPayout(booted, apiKey, {
      destinationAddress: "0xdddddddddddddddddddddddddddddddddddddddd"
    });

    const { body } = await listPayouts(
      booted,
      apiKey,
      `?destinationAddress=${target}`
    );
    expect(body.payouts).toHaveLength(1);
    expect(body.payouts?.[0]?.["id"]).toBe(a.id);
  });

  it("filters by status", async () => {
    await planPayout(booted, apiKey, {});
    const { body } = await listPayouts(booted, apiKey, "?status=planned");
    expect(body.payouts).toHaveLength(1);

    const confirmed = await listPayouts(booted, apiKey, "?status=confirmed");
    expect(confirmed.body.payouts).toHaveLength(0);
  });

  it("rejects unknown status with 400", async () => {
    const { status, body } = await listPayouts(booted, apiKey, "?status=weird");
    expect(status).toBe(400);
    expect(body.error?.code).toBe("BAD_STATUS");
  });

  it("paginates with limit + offset", async () => {
    for (let i = 0; i < 4; i += 1) {
      const suffix = i.toString(16).padStart(2, "0");
      await planPayout(booted, apiKey, {
        destinationAddress: `0x${suffix}${"0".repeat(38)}`
      });
    }
    const page1 = await listPayouts(booted, apiKey, "?limit=2");
    expect(page1.body.payouts).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await listPayouts(booted, apiKey, "?limit=2&offset=2");
    expect(page2.body.payouts).toHaveLength(2);
    expect(page2.body.hasMore).toBe(false);
  });

  it("401s without an API key", async () => {
    const res = await booted.app.fetch(new Request("http://test.local/api/v1/payouts"));
    expect(res.status).toBe(401);
  });
});
