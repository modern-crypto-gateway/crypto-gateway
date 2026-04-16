import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, createOrderViaApi, type BootedTestApp } from "../helpers/boot.js";

describe("GET /checkout/:id", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp();
  });

  afterEach(async () => {
    await booted.close();
  });

  it("returns a public, merchant-free snapshot of the order", async () => {
    const order = await createOrderViaApi(booted, { amountRaw: "1500000" });

    const res = await booted.app.fetch(new Request(`http://test.local/checkout/${order.id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: Record<string, unknown> };
    expect(body.order).toMatchObject({
      id: order.id,
      status: "created",
      chainId: 999,
      token: "DEV",
      requiredAmountRaw: "1500000",
      receivedAmountRaw: "0"
    });
    // Merchant identity and internal bookkeeping must NOT appear in the public view.
    expect(body.order["merchantId"]).toBeUndefined();
    expect(body.order["updatedAt"]).toBeUndefined();
    expect(body.order["metadata"]).toBeUndefined();
    expect(body.order["addressIndex"]).toBeUndefined();
  });

  it("is unauthenticated: no API key required", async () => {
    const order = await createOrderViaApi(booted, { amountRaw: "1" });
    // Deliberately no Authorization header.
    const res = await booted.app.fetch(new Request(`http://test.local/checkout/${order.id}`));
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown order id", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/checkout/00000000-0000-0000-0000-ffffffffffff")
    );
    expect(res.status).toBe(404);
  });
});
