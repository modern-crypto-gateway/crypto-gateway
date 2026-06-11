import { describe, expect, it } from "vitest";
import {
  tronSaveProvider,
  TRONSAVE_MAINNET_URL,
  TRONSAVE_NILE_URL
} from "../../../adapters/energy-rental/tronsave.adapter.js";

// Capture-and-respond fetch stub. Each call shifts the next queued response;
// requests are recorded for assertion.
function fakeFetch(
  responses: Array<{ status?: number; body: unknown }>
): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
} {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
        ),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      const next = responses.shift();
      if (!next) throw new Error("fakeFetch: no queued response");
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" }
      });
    }
  };
}

const RECEIVER = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

describe("tronSaveProvider", () => {
  it("estimates an energy order with the apikey header against the mainnet base URL", async () => {
    const { fetch, requests } = fakeFetch([
      { body: { error: false, message: "Success", data: { unitPrice: 64, durationSec: 3600, estimateTrx: 4160000, availableResource: 900000 } } }
    ]);
    const provider = tronSaveProvider({ apiKey: "k-123", fetch });

    const estimate = await provider.estimateEnergyOrder({ receiver: RECEIVER, energyAmount: 65000, durationSec: 3600 });

    expect(estimate).toEqual({ unitPriceSun: 64, totalCostSun: 4160000n, availableEnergy: 900000 });
    expect(requests[0]!.url).toBe(`${TRONSAVE_MAINNET_URL}/v2/estimate-buy-resource`);
    expect(requests[0]!.headers["apikey"]).toBe("k-123");
    expect(requests[0]!.body).toMatchObject({
      resourceType: "ENERGY",
      receiver: RECEIVER,
      resourceAmount: 65000,
      durationSec: 3600,
      unitPrice: "MEDIUM"
    });
  });

  it("targets the nile dev environment when configured", async () => {
    const { fetch, requests } = fakeFetch([
      { body: { error: false, data: { balance: "12000000" } } }
    ]);
    const provider = tronSaveProvider({ apiKey: "k", baseUrl: TRONSAVE_NILE_URL, fetch });
    await provider.getAccountBalanceSun();
    expect(requests[0]!.url).toBe(`${TRONSAVE_NILE_URL}/v2/user-info`);
  });

  it("creates an all-or-nothing order with the price ceiling and returns the orderId", async () => {
    const { fetch, requests } = fakeFetch([
      { body: { error: false, message: "Success", data: { orderId: "6818426a65fa8ea36d119d2c" } } }
    ]);
    const provider = tronSaveProvider({ apiKey: "k", fetch });

    const order = await provider.createEnergyOrder({
      receiver: RECEIVER,
      energyAmount: 70200,
      durationSec: 3600,
      maxUnitPriceSun: 90
    });

    expect(order.orderId).toBe("6818426a65fa8ea36d119d2c");
    expect(requests[0]!.url).toBe(`${TRONSAVE_MAINNET_URL}/v2/buy-resource`);
    expect(requests[0]!.body).toMatchObject({
      resourceType: "ENERGY",
      receiver: RECEIVER,
      resourceAmount: 70200,
      options: {
        onlyCreateWhenFulfilled: true,
        allowPartialFill: false,
        preventDuplicateIncompleteOrders: true,
        maxPriceAccepted: 90
      }
    });
  });

  it("reads order status with the actual paid amount", async () => {
    const { fetch, requests } = fakeFetch([
      { body: { error: false, data: { fulfilledPercent: 100, payoutAmount: 4230000 } } }
    ]);
    const provider = tronSaveProvider({ apiKey: "k", fetch });

    const status = await provider.getOrderStatus("abc/123");

    expect(status).toEqual({ fulfilledPercent: 100, paidSun: 4230000n });
    // Path-encodes the id so a hostile orderId can't traverse the URL.
    expect(requests[0]!.url).toBe(`${TRONSAVE_MAINNET_URL}/v2/order/abc%2F123`);
  });

  it("reports null paidSun while the provider hasn't priced the fill yet", async () => {
    const { fetch } = fakeFetch([{ body: { error: false, data: { fulfilledPercent: 40 } } }]);
    const provider = tronSaveProvider({ apiKey: "k", fetch });
    const status = await provider.getOrderStatus("x");
    expect(status).toEqual({ fulfilledPercent: 40, paidSun: null });
  });

  it("throws on the error envelope (order rejected) instead of returning garbage", async () => {
    const { fetch } = fakeFetch([
      { body: { error: true, message: "CANNOT_FULFILLED" } }
    ]);
    const provider = tronSaveProvider({ apiKey: "k", fetch });
    await expect(
      provider.createEnergyOrder({ receiver: RECEIVER, energyAmount: 65000, durationSec: 3600, maxUnitPriceSun: 90 })
    ).rejects.toThrow(/CANNOT_FULFILLED/);
  });

  it("throws on non-2xx responses with the status surfaced", async () => {
    const { fetch } = fakeFetch([{ status: 429, body: { message: "rate limited" } }]);
    const provider = tronSaveProvider({ apiKey: "k", fetch });
    await expect(provider.getAccountBalanceSun()).rejects.toThrow(/429/);
  });

  it("throws on unusable estimate pricing rather than letting a zero-cost rental through", async () => {
    // A zero estimateTrx would make ANY rental look cheaper than burning;
    // treat it as a provider bug and fall back to burn upstream.
    const { fetch } = fakeFetch([
      { body: { error: false, data: { unitPrice: 0, estimateTrx: 0, availableResource: 900000 } } }
    ]);
    const provider = tronSaveProvider({ apiKey: "k", fetch });
    await expect(
      provider.estimateEnergyOrder({ receiver: RECEIVER, energyAmount: 65000, durationSec: 3600 })
    ).rejects.toThrow(/unusable pricing/);
  });
});
