import { describe, expect, it } from "vitest";
import { composeWebhook } from "../../core/domain/webhook-composer.js";
import type { Order, OrderId } from "../../core/types/order.js";
import type { Payout, PayoutId } from "../../core/types/payout.js";
import type { MerchantId } from "../../core/types/merchant.js";

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "00000000-0000-0000-0000-0000000000aa" as OrderId,
    merchantId: "00000000-0000-0000-0000-000000000001" as MerchantId,
    status: "detected",
    chainId: 1,
    token: "USDC",
    receiveAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    addressIndex: 0,
    acceptedFamilies: ["evm"],
    receiveAddresses: [
      {
        family: "evm",
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as never,
        poolAddressId: "00000000-0000-0000-0000-0000000000f0"
      }
    ],
    requiredAmountRaw: "1000000",
    receivedAmountRaw: "1000000",
    fiatAmount: "1.00",
    fiatCurrency: "USD",
    quotedRate: "1",
    externalId: "cart-42",
    metadata: { source: "test" },
    createdAt: new Date("2026-04-16T10:00:00Z"),
    expiresAt: new Date("2026-04-16T10:30:00Z"),
    confirmedAt: null,
    updatedAt: new Date("2026-04-16T10:01:00Z"),
    ...overrides
  };
}

function fixturePayout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: "00000000-0000-0000-0000-0000000000bb" as PayoutId,
    merchantId: "00000000-0000-0000-0000-000000000001" as MerchantId,
    status: "submitted",
    chainId: 1,
    token: "USDC",
    amountRaw: "500000",
    destinationAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    sourceAddress: "0x1111111111111111111111111111111111111111",
    txHash: "0xabc",
    feeEstimateNative: "21000",
    lastError: null,
    createdAt: new Date("2026-04-16T10:00:00Z"),
    submittedAt: new Date("2026-04-16T10:05:00Z"),
    confirmedAt: null,
    updatedAt: new Date("2026-04-16T10:05:00Z"),
    ...overrides
  };
}

describe("composeWebhook", () => {
  it("maps order.detected to a merchant-visible event with a stable idempotency key", () => {
    const order = fixtureOrder();
    const composed = composeWebhook({
      type: "order.detected",
      orderId: order.id,
      order,
      at: new Date("2026-04-16T10:01:00Z")
    });
    expect(composed).not.toBeNull();
    expect(composed!.merchantId).toBe(order.merchantId);
    expect(composed!.payload.event).toBe("order.detected");
    expect(composed!.payload.timestamp).toBe("2026-04-16T10:01:00.000Z");
    expect(composed!.payload.data).toMatchObject({
      id: order.id,
      status: "detected",
      requiredAmountRaw: "1000000",
      receivedAmountRaw: "1000000",
      externalId: "cart-42"
    });
    expect(composed!.idempotencyKey).toBe(`order.detected:${order.id}:detected`);
  });

  it("returns null for internal events (order.created, tx.*, payout.planned)", () => {
    const order = fixtureOrder({ status: "created" });
    expect(
      composeWebhook({ type: "order.created", orderId: order.id, order, at: new Date() })
    ).toBeNull();
  });

  it("maps payout.confirmed with the expected data shape", () => {
    const payout = fixturePayout({ status: "confirmed", confirmedAt: new Date("2026-04-16T10:10:00Z") });
    const composed = composeWebhook({
      type: "payout.confirmed",
      payoutId: payout.id,
      payout,
      at: new Date("2026-04-16T10:10:00Z")
    });
    expect(composed).not.toBeNull();
    expect(composed!.payload.event).toBe("payout.confirmed");
    expect(composed!.payload.data).toMatchObject({
      id: payout.id,
      status: "confirmed",
      amountRaw: "500000",
      destinationAddress: payout.destinationAddress,
      sourceAddress: payout.sourceAddress,
      txHash: "0xabc"
    });
    expect(composed!.idempotencyKey).toBe(`payout.confirmed:${payout.id}:confirmed`);
  });

  it("serializes dates as ISO strings (no raw Date objects in the payload)", () => {
    const order = fixtureOrder();
    const composed = composeWebhook({
      type: "order.confirmed",
      orderId: order.id,
      order,
      at: new Date("2026-04-16T10:05:00Z")
    });
    const data = composed!.payload.data;
    expect(typeof data["createdAt"]).toBe("string");
    expect(typeof data["expiresAt"]).toBe("string");
    // JSON-round-trip: must survive serialization without losing fidelity.
    expect(() => JSON.parse(JSON.stringify(composed!.payload))).not.toThrow();
  });
});
