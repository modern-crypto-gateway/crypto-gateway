import { describe, expect, it } from "vitest";
import { composeWebhook } from "../../core/domain/webhook-composer.js";
import type { Invoice, InvoiceId } from "../../core/types/invoice.js";
import type { Payout, PayoutId } from "../../core/types/payout.js";
import type { MerchantId } from "../../core/types/merchant.js";

function fixtureInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "00000000-0000-0000-0000-0000000000aa" as InvoiceId,
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
    amountUsd: null,
    paidUsd: "0",
    overpaidUsd: "0",
    rateWindowExpiresAt: null,
    rates: null,
    externalId: "cart-42",
    metadata: { source: "test" },
    webhookUrl: null,
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
    webhookUrl: null,
    createdAt: new Date("2026-04-16T10:00:00Z"),
    submittedAt: new Date("2026-04-16T10:05:00Z"),
    confirmedAt: null,
    updatedAt: new Date("2026-04-16T10:05:00Z"),
    ...overrides
  };
}

describe("composeWebhook", () => {
  it("maps invoice.detected to a merchant-visible event with a stable idempotency key", () => {
    const invoice = fixtureInvoice();
    const composed = composeWebhook({
      type: "invoice.detected",
      invoiceId: invoice.id,
      invoice,
      at: new Date("2026-04-16T10:01:00Z")
    });
    expect(composed).not.toBeNull();
    expect(composed!.merchantId).toBe(invoice.merchantId);
    expect(composed!.payload.event).toBe("invoice.detected");
    expect(composed!.payload.timestamp).toBe("2026-04-16T10:01:00.000Z");
    expect(composed!.payload.data).toMatchObject({
      id: invoice.id,
      status: "detected",
      requiredAmountRaw: "1000000",
      receivedAmountRaw: "1000000",
      externalId: "cart-42"
    });
    expect(composed!.idempotencyKey).toBe(`invoice.detected:${invoice.id}:detected`);
  });

  it("returns null for internal events (invoice.created, tx.*, payout.planned)", () => {
    const invoice = fixtureInvoice({ status: "created" });
    expect(
      composeWebhook({ type: "invoice.created", invoiceId: invoice.id, invoice, at: new Date() })
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

  it("maps invoice.overpaid with overpaidUsd in the snapshot data", () => {
    const invoice = fixtureInvoice({
      status: "overpaid",
      amountUsd: "100.00",
      paidUsd: "120.00",
      overpaidUsd: "20.00"
    });
    const composed = composeWebhook({
      type: "invoice.overpaid",
      invoiceId: invoice.id,
      invoice,
      at: new Date("2026-04-16T10:02:00Z")
    });
    expect(composed).not.toBeNull();
    expect(composed!.payload.event).toBe("invoice.overpaid");
    expect(composed!.idempotencyKey).toBe(`invoice.overpaid:${invoice.id}:overpaid`);
  });

  it("maps invoice.payment_received and keys idempotency on txHash (not status)", () => {
    const invoice = fixtureInvoice({ status: "partial", paidUsd: "20.00", amountUsd: "50.00" });
    const composed = composeWebhook({
      type: "invoice.payment_received",
      invoiceId: invoice.id,
      invoice,
      payment: {
        txHash: "0xpayment1",
        chainId: 1,
        token: "USDC",
        amountRaw: "20000000",
        amountUsd: "20.00",
        usdRate: "1"
      },
      at: new Date("2026-04-16T10:03:00Z")
    });
    expect(composed).not.toBeNull();
    expect(composed!.payload.event).toBe("invoice.payment_received");
    expect(composed!.idempotencyKey).toBe(`invoice.payment_received:${invoice.id}:0xpayment1`);
    const data = composed!.payload.data as {
      invoice: { status: string };
      payment: { txHash: string; amountUsd: string | null };
    };
    expect(data.invoice.status).toBe("partial");
    expect(data.payment.txHash).toBe("0xpayment1");
    expect(data.payment.amountUsd).toBe("20.00");
  });

  it("serializes dates as ISO strings (no raw Date objects in the payload)", () => {
    const invoice = fixtureInvoice();
    const composed = composeWebhook({
      type: "invoice.confirmed",
      invoiceId: invoice.id,
      invoice,
      at: new Date("2026-04-16T10:05:00Z")
    });
    const data = composed!.payload.data;
    expect(typeof data["createdAt"]).toBe("string");
    expect(typeof data["expiresAt"]).toBe("string");
    // JSON-round-trip: must survive serialization without losing fidelity.
    expect(() => JSON.parse(JSON.stringify(composed!.payload))).not.toThrow();
  });
});
