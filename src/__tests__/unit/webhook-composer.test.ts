import { describe, expect, it } from "vitest";
import { composeWebhook, __formatAmountForTest } from "../../core/domain/webhook-composer.js";
import type { TransactionPayload } from "../../core/domain/webhook-composer.js";
import type { Invoice, InvoiceId } from "../../core/types/invoice.js";
import type { Payout, PayoutId } from "../../core/types/payout.js";
import type { MerchantId } from "../../core/types/merchant.js";

// Composer is pure: receives an event + pre-loaded transactions[]. Tests pin
// (1) the wire event-name mapping (dot internal → colon external),
// (2) the (status, extraStatus) snapshot in the invoice envelope,
// (3) idempotency-key construction (status-keyed for lifecycle events,
//     txHash-keyed for per-tx events),
// (4) the transactions[] passthrough + triggerTxHash on per-tx events.

function fixtureInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "00000000-0000-0000-0000-0000000000aa" as InvoiceId,
    merchantId: "00000000-0000-0000-0000-000000000001" as MerchantId,
    status: "processing",
    extraStatus: null,
    chainId: 1,
    token: "USDC",
    receiveAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    addressIndex: 0,
    acceptedFamilies: ["evm"],
    receiveAddresses: [
      {
        family: "evm",
        chainId: 1,
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
    paymentToleranceUnderBps: 0,
    paymentToleranceOverBps: 0,
    confirmationThreshold: 12,
    confirmationTiers: null,
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
    quotedAmountUsd: null,
    quotedRate: null,
    feeTier: null,
    feeQuotedNative: null,
    batchId: null,
    kind: "standard",
    parentPayoutId: null,
    topUpTxHash: null,
    topUpSponsorAddress: null,
    topUpAmountRaw: null,
    broadcastAttemptedAt: null,
    destinationAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    sourceAddress: "0x1111111111111111111111111111111111111111",
    txHash: "0xabc",
    feeEstimateNative: "21000",
    lastError: null,
    webhookUrl: null,
    confirmationThreshold: 12,
    confirmationTiers: null,
    createdAt: new Date("2026-04-16T10:00:00Z"),
    submittedAt: new Date("2026-04-16T10:05:00Z"),
    confirmedAt: null,
    updatedAt: new Date("2026-04-16T10:05:00Z"),
    ...overrides
  };
}

function fixtureTx(overrides: Partial<TransactionPayload> = {}): TransactionPayload {
  return {
    hash: "0xpayment1",
    chainId: 1,
    chainName: "ethereum",
    token: "USDC",
    isNative: false,
    amount: "1.0",
    amountRaw: "1000000",
    amountUsd: "1.00",
    confirmations: 12,
    status: "confirmed",
    ...overrides
  };
}

describe("composeWebhook", () => {
  it("maps invoice.completed (internal) to invoice:completed (wire) with full envelope", () => {
    const invoice = fixtureInvoice({ status: "completed", extraStatus: null });
    const txs = [fixtureTx()];
    const composed = composeWebhook(
      { type: "invoice.completed", invoiceId: invoice.id, invoice, at: new Date("2026-04-16T10:01:00Z") },
      txs
    );
    expect(composed).not.toBeNull();
    expect(composed!.merchantId).toBe(invoice.merchantId);
    expect(composed!.payload.event).toBe("invoice:completed");
    expect(composed!.payload.timestamp).toBe("2026-04-16T10:01:00.000Z");
    const data = composed!.payload.data as {
      invoice: { status: string; extraStatus: string | null };
      transactions: TransactionPayload[];
      triggerTxHash: string | null;
    };
    expect(data.invoice.status).toBe("completed");
    expect(data.invoice.extraStatus).toBeNull();
    expect(data.transactions).toEqual(txs);
    expect(data.triggerTxHash).toBeNull();
    expect(composed!.idempotencyKey).toBe(`invoice:completed:${invoice.id}:completed`);
  });

  it("maps invoice.processing → invoice:processing with idempotency key encoding (status, extra_status)", () => {
    // pending → processing (full amount in flight, no extra). Distinct
    // delivery from a processing(partial) event so the merchant UI can
    // distinguish "payment seen but partial" from "payment fully landed,
    // awaiting confirmations".
    const fullInFlight = fixtureInvoice({ status: "processing", extraStatus: null });
    const composedFull = composeWebhook(
      { type: "invoice.processing", invoiceId: fullInFlight.id, invoice: fullInFlight, at: new Date("2026-04-16T10:00:30Z") }
    );
    expect(composedFull).not.toBeNull();
    expect(composedFull!.payload.event).toBe("invoice:processing");
    expect(composedFull!.idempotencyKey).toBe(`invoice:processing:${fullInFlight.id}:processing:none`);

    // processing(partial) — distinct key from the full-in-flight delivery
    // above. A partial-then-full sequence delivers TWO webhooks.
    const partial = fixtureInvoice({ status: "processing", extraStatus: "partial" });
    const composedPartial = composeWebhook(
      { type: "invoice.processing", invoiceId: partial.id, invoice: partial, at: new Date("2026-04-16T10:00:31Z") }
    );
    expect(composedPartial!.idempotencyKey).toBe(`invoice:processing:${partial.id}:processing:partial`);
    const data = composedPartial!.payload.data as { invoice: { status: string; extraStatus: string | null } };
    expect(data.invoice.status).toBe("processing");
    expect(data.invoice.extraStatus).toBe("partial");
  });

  it("returns null for internal events (invoice.created, tx.*, payout.planned)", () => {
    const invoice = fixtureInvoice({ status: "pending" });
    expect(
      composeWebhook({ type: "invoice.created", invoiceId: invoice.id, invoice, at: new Date() })
    ).toBeNull();
  });

  it("propagates extraStatus='overpaid' in the snapshot for completed invoices that overshot", () => {
    const invoice = fixtureInvoice({
      status: "completed",
      extraStatus: "overpaid",
      amountUsd: "100.00",
      paidUsd: "120.00",
      overpaidUsd: "20.00"
    });
    const composed = composeWebhook(
      { type: "invoice.completed", invoiceId: invoice.id, invoice, at: new Date("2026-04-16T10:02:00Z") },
      [fixtureTx({ amountUsd: "120.00", amountRaw: "120000000", amount: "120.0" })]
    );
    expect(composed!.payload.event).toBe("invoice:completed");
    const data = composed!.payload.data as { invoice: { extraStatus: string; overpaidUsd: string } };
    expect(data.invoice.extraStatus).toBe("overpaid");
    expect(data.invoice.overpaidUsd).toBe("20.00");
  });

  it("maps invoice.payment_confirmed → invoice:payment_confirmed and keys idempotency on txHash", () => {
    const invoice = fixtureInvoice({
      status: "processing",
      extraStatus: "partial",
      paidUsd: "20.00",
      amountUsd: "50.00"
    });
    const txs = [fixtureTx({ hash: "0xpayment1", amount: "20.0", amountRaw: "20000000", amountUsd: "20.00" })];
    const composed = composeWebhook(
      {
        type: "invoice.payment_confirmed",
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
      },
      txs
    );
    expect(composed!.payload.event).toBe("invoice:payment_confirmed");
    expect(composed!.idempotencyKey).toBe(`invoice:payment_confirmed:${invoice.id}:0xpayment1`);
    const data = composed!.payload.data as {
      invoice: { status: string; extraStatus: string | null };
      transactions: TransactionPayload[];
      triggerTxHash: string;
    };
    expect(data.invoice.status).toBe("processing");
    expect(data.invoice.extraStatus).toBe("partial");
    expect(data.transactions).toEqual(txs);
    expect(data.triggerTxHash).toBe("0xpayment1");
  });

  it("maps invoice.payment_detected with confirmations in the tx and a per-tx idempotency key", () => {
    const invoice = fixtureInvoice({ status: "pending", extraStatus: null });
    const txs = [
      fixtureTx({ hash: "0xpending", status: "detected", confirmations: 1, amount: "20.0", amountRaw: "20000000" })
    ];
    const composed = composeWebhook(
      {
        type: "invoice.payment_detected",
        invoiceId: invoice.id,
        invoice,
        payment: {
          txHash: "0xpending",
          chainId: 1,
          token: "USDC",
          amountRaw: "20000000",
          amountUsd: "20.00",
          usdRate: "1",
          confirmations: 1
        },
        at: new Date("2026-04-16T10:04:00Z")
      },
      txs
    );
    expect(composed!.payload.event).toBe("invoice:payment_detected");
    expect(composed!.idempotencyKey).toBe(`invoice:payment_detected:${invoice.id}:0xpending`);
    const data = composed!.payload.data as {
      transactions: TransactionPayload[];
      triggerTxHash: string;
    };
    expect(data.transactions[0]?.confirmations).toBe(1);
    expect(data.triggerTxHash).toBe("0xpending");
  });

  it("payment_detected and payment_confirmed for the same tx produce DISTINCT idempotency keys", () => {
    // Same invoice, same tx, different stages → two separate webhook rows
    // (one for the unconfirmed sighting, one for the confirmation).
    const invoice = fixtureInvoice({ status: "processing", extraStatus: "partial" });
    const detected = composeWebhook(
      {
        type: "invoice.payment_detected",
        invoiceId: invoice.id,
        invoice,
        payment: {
          txHash: "0xshared",
          chainId: 1,
          token: "USDC",
          amountRaw: "1",
          amountUsd: null,
          usdRate: null,
          confirmations: 0
        },
        at: new Date("2026-04-16T10:00:00Z")
      },
      []
    );
    const confirmed = composeWebhook(
      {
        type: "invoice.payment_confirmed",
        invoiceId: invoice.id,
        invoice,
        payment: {
          txHash: "0xshared",
          chainId: 1,
          token: "USDC",
          amountRaw: "1",
          amountUsd: null,
          usdRate: null
        },
        at: new Date("2026-04-16T10:05:00Z")
      },
      []
    );
    expect(detected!.idempotencyKey).not.toBe(confirmed!.idempotencyKey);
  });

  it("invoice:demoted carries previousStatus + pool reorg metadata", () => {
    const invoice = fixtureInvoice({ status: "processing", extraStatus: "partial" });
    const composed = composeWebhook(
      {
        type: "invoice.demoted",
        invoiceId: invoice.id,
        invoice,
        previousStatus: "completed",
        poolReacquired: 1,
        poolCollided: 0,
        at: new Date("2026-04-16T10:10:00Z")
      },
      [fixtureTx({ status: "orphaned" })]
    );
    expect(composed!.payload.event).toBe("invoice:demoted");
    const data = composed!.payload.data as {
      previousStatus: string;
      poolReacquired: number;
      poolCollided: number;
    };
    expect(data.previousStatus).toBe("completed");
    expect(data.poolReacquired).toBe(1);
    expect(data.poolCollided).toBe(0);
  });

  it("maps payout.confirmed with the expected data shape (no transactions[])", () => {
    const payout = fixturePayout({ status: "confirmed", confirmedAt: new Date("2026-04-16T10:10:00Z") });
    const composed = composeWebhook({
      type: "payout.confirmed",
      payoutId: payout.id,
      payout,
      at: new Date("2026-04-16T10:10:00Z")
    });
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

  // Contract test: webhook payload shape must match the REST `GET /payouts/:id`
  // shape one-for-one (modulo Date → ISO string serialization).
  it("payout webhook data carries every Payout field the REST surface exposes", () => {
    const payout = fixturePayout({
      kind: "standard",
      parentPayoutId: null,
      feeTier: "medium",
      feeQuotedNative: "21000",
      batchId: "batch-abc",
      topUpTxHash: "0xtopup",
      topUpSponsorAddress: "0xsponsor"
    });
    const composed = composeWebhook({
      type: "payout.submitted",
      payoutId: payout.id,
      payout,
      at: new Date("2026-04-16T10:05:00Z")
    });
    expect(composed).not.toBeNull();
    const data = composed!.payload.data as Record<string, unknown>;
    for (const k of [
      "id", "kind", "parentPayoutId", "status", "chainId", "token", "amountRaw",
      "feeTier", "feeQuotedNative", "batchId",
      "destinationAddress", "sourceAddress", "txHash",
      "topUpTxHash", "topUpSponsorAddress",
      "lastError", "submittedAt", "confirmedAt"
    ]) {
      expect(data, `missing ${k}`).toHaveProperty(k);
    }
    expect(data.kind).toBe("standard");
    expect(data.topUpTxHash).toBe("0xtopup");
    expect(data.topUpSponsorAddress).toBe("0xsponsor");
    expect(data.batchId).toBe("batch-abc");
  });

  it("serializes dates as ISO strings (no raw Date objects in the payload)", () => {
    const invoice = fixtureInvoice({ status: "completed" });
    const composed = composeWebhook(
      { type: "invoice.completed", invoiceId: invoice.id, invoice, at: new Date("2026-04-16T10:05:00Z") },
      []
    );
    const data = (composed!.payload.data as { invoice: Record<string, unknown> }).invoice;
    expect(typeof data["createdAt"]).toBe("string");
    expect(typeof data["expiresAt"]).toBe("string");
    // JSON-round-trip: must survive serialization without losing fidelity.
    expect(() => JSON.parse(JSON.stringify(composed!.payload))).not.toThrow();
  });
});

describe("formatAmount (helper)", () => {
  // Pure-function pinning: the human-decimal formatter must handle 6, 9,
  // and 18-decimal tokens without losing precision.
  it.each([
    ["1500000", 6, "1.5"],
    ["1000000", 6, "1"],
    ["100", 6, "0.0001"],
    ["12345678901234567890", 18, "12.34567890123456789"],
    ["5000", 9, "0.000005"],
    ["0", 6, "0"],
    ["1", 0, "1"]
  ])("formatAmount(%s, %s) = %s", (raw, decimals, expected) => {
    expect(__formatAmountForTest(raw, decimals as number)).toBe(expected);
  });
});
