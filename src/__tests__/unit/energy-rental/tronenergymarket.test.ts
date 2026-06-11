import { describe, expect, it } from "vitest";
import {
  tronEnergyMarketProvider,
  TRONENERGY_MARKET_URL
} from "../../../adapters/energy-rental/tronenergymarket.adapter.js";

function fakeFetch(
  responses: Array<{ status?: number; body: unknown }>
): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: Array<{ url: string; method: string; body: unknown }>;
} {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
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

const ACCOUNT = "TGMvWrWVqQXUdfNeYRrnNCkbZkKkpRZJAA";
const RECEIVER = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

// Mirrors the live /info shape (2026-06): tier prices are SUN per unit per
// DAY; sub-day orders bill as duration + 1 day.
const INFO_BODY = {
  order: { minEnergy: 20000 },
  price: {
    openEnergy: [
      { minDuration: 300, basePrice: 35, minPoolPrice: 30, suggestedPrice: 35 },
      { minDuration: 3600, basePrice: 40, minPoolPrice: 30, suggestedPrice: 40 },
      { minDuration: 86400, basePrice: 55, minPoolPrice: 30, suggestedPrice: 55 }
    ]
  },
  market: {
    availableEnergyByPrice: [
      { price: 30, value: 35_000_000 },
      { price: 35, value: 13_000_000 },
      { price: 40, value: 3_000_000 }
    ]
  }
};

function provider(responses: Array<{ status?: number; body: unknown }>) {
  const { fetch, requests } = fakeFetch(responses);
  return { provider: tronEnergyMarketProvider({ apiKey: "tem-key", accountAddress: ACCOUNT, fetch }), requests };
}

describe("tronEnergyMarketProvider", () => {
  it("estimates a 10-minute order with the sub-day billing pad applied", async () => {
    const { provider: tem } = provider([{ body: INFO_BODY }]);

    const estimate = await tem.estimateEnergyOrder({ receiver: RECEIVER, energyAmount: 140_000, durationSec: 600 });

    // Tier for 600s = minDuration 300 → 35 SUN/day-unit.
    // Cost = ceil(35 × 140000 × (600 + 86400) / 86400) = 4_934_028 — matches
    // TEM's own checkout total (4.934027 TRX) up to the ceil.
    expect(estimate.totalCostSun).toBe(4_934_028n);
    // Effective per-unit price includes the pad: 35 × 87000/86400 ≈ 35.24.
    expect(estimate.unitPriceSun).toBeCloseTo(35.24, 1);
    // Depth our bid can pull from = supply priced at or below 35.
    expect(estimate.availableEnergy).toBe(48_000_000);
  });

  it("uses the 1-day tier without padding for 86400s", async () => {
    const { provider: tem } = provider([{ body: INFO_BODY }]);
    const estimate = await tem.estimateEnergyOrder({ receiver: RECEIVER, energyAmount: 100_000, durationSec: 86_400 });
    // ceil(55 × 100000 × 86400/86400) = 5_500_000 — no sub-day pad.
    expect(estimate.totalCostSun).toBe(5_500_000n);
    expect(estimate.unitPriceSun).toBe(55);
  });

  it("clamps below-minimum orders up to TEM's floor and prices the clamped amount", async () => {
    const { provider: tem } = provider([{ body: INFO_BODY }]);
    const estimate = await tem.estimateEnergyOrder({ receiver: RECEIVER, energyAmount: 5_000, durationSec: 600 });
    // ceil(35 × 20000 × 87000/86400) — priced at the clamped 20k, so the
    // caller's rent-vs-burn comparison sees the true cost.
    expect(estimate.totalCostSun).toBe(704_862n);
  });

  it("creates an all-or-nothing instant order paid from credit", async () => {
    const { provider: tem, requests } = provider([
      { body: INFO_BODY },
      { body: { order: 5144999 } }
    ]);

    const order = await tem.createEnergyOrder({
      receiver: RECEIVER,
      energyAmount: 140_000,
      durationSec: 600,
      maxUnitPriceSun: 90
    });

    expect(order.orderId).toBe("5144999");
    const create = requests[1]!;
    expect(create.url).toBe(`${TRONENERGY_MARKET_URL}/order/new`);
    expect(create.body).toMatchObject({
      market: "Open",
      address: ACCOUNT,
      target: RECEIVER,
      amount: 140_000,
      resource: 0,
      duration: 600,
      price: 35,
      partfill: false,
      instant: true,
      api_key: "tem-key"
    });
  });

  it("enforces the caller's unit-price ceiling client-side (TEM has no server cap)", async () => {
    const { provider: tem, requests } = provider([{ body: INFO_BODY }]);
    await expect(
      tem.createEnergyOrder({ receiver: RECEIVER, energyAmount: 140_000, durationSec: 600, maxUnitPriceSun: 30 })
    ).rejects.toThrow(/exceeds ceiling/);
    // Only /info was hit — no order request went out.
    expect(requests).toHaveLength(1);
  });

  it("maps Active orders to 100% with the actual payment", async () => {
    const { provider: tem } = provider([
      { body: { status: "Active", freeze: 100, frozen: 100, payment: 4_934_028 } }
    ]);
    const status = await tem.getOrderStatus("5144999");
    expect(status).toEqual({ fulfilledPercent: 100, paidSun: 4_934_028n });
  });

  it("maps a pending partially-frozen order to its fill ratio without a paid amount", async () => {
    const { provider: tem } = provider([
      { body: { status: "Pending", freeze: 3_102_061_000_000, frozen: 454_914_000_000, payment: 42_240_697_200 } }
    ]);
    const status = await tem.getOrderStatus("5144358");
    expect(status.fulfilledPercent).toBe(14);
    expect(status.paidSun).toBeNull();
  });

  it("maps cancelled orders to 0%", async () => {
    const { provider: tem } = provider([{ body: { status: "Cancelled", freeze: 100, frozen: 100 } }]);
    const status = await tem.getOrderStatus("1");
    expect(status.fulfilledPercent).toBe(0);
  });

  it("cancels an order via POST /order/cancel and reports rejection as false", async () => {
    const { provider: tem, requests } = provider([
      { body: { ok: true } },
      { status: 400, body: { error: "already filled" } }
    ]);
    expect(await tem.cancelOrder!("777")).toBe(true);
    expect(requests[0]!.url).toBe(`${TRONENERGY_MARKET_URL}/order/cancel`);
    expect(requests[0]!.body).toMatchObject({ order: 777, address: ACCOUNT, api_key: "tem-key" });
    expect(await tem.cancelOrder!("778")).toBe(false);
  });

  it("reads the prepaid credit balance", async () => {
    const { provider: tem, requests } = provider([{ body: { value: 12_602_060 } }]);
    expect(await tem.getAccountBalanceSun()).toBe(12_602_060n);
    expect(requests[0]!.url).toBe(`${TRONENERGY_MARKET_URL}/credit?address=${ACCOUNT}`);
  });

  it("throws when /info has no usable price tiers instead of quoting garbage", async () => {
    const { provider: tem } = provider([{ body: { price: { openEnergy: [] } } }]);
    await expect(
      tem.estimateEnergyOrder({ receiver: RECEIVER, energyAmount: 140_000, durationSec: 600 })
    ).rejects.toThrow(/no usable/);
  });
});
