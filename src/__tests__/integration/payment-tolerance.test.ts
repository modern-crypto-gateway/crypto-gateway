import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { custom } from "viem";
import { invoices, merchants } from "../../db/schema.js";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import type { AmountRaw } from "../../core/types/money.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

const noopTransport = custom({
  async request() {
    throw new Error("EVM adapter touched RPC unexpectedly");
  }
});

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

async function bootEvmOnly(
  merchantOverrides: Partial<{
    paymentToleranceUnderBps: number;
    paymentToleranceOverBps: number;
  }> = {}
): Promise<BootedTestApp> {
  return bootTestApp({
    chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
    poolInitialSize: 5,
    merchants: [
      {
        id: MERCHANT_ID,
        name: "Test Merchant",
        active: true,
        ...merchantOverrides
      }
    ]
  });
}

async function createUsdInvoice(
  booted: BootedTestApp,
  apiKey: string,
  body: Record<string, unknown>
): Promise<{ id: string; receiveAddress: string; paymentToleranceUnderBps: number; paymentToleranceOverBps: number }> {
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/invoices", {
      method: "POST",
      headers: authHeader(apiKey),
      body: JSON.stringify({
        chainId: 1,
        token: "USDC",
        acceptedFamilies: ["evm"],
        ...body
      })
    })
  );
  if (res.status !== 201) throw new Error(`createUsdInvoice: ${res.status} ${await res.text()}`);
  const parsed = (await res.json()) as {
    invoice: {
      id: string;
      receiveAddress: string;
      paymentToleranceUnderBps: number;
      paymentToleranceOverBps: number;
    };
  };
  return parsed.invoice;
}

describe("payment tolerance — under-payment closes as confirmed within band", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    // Merchant default: 100 bps (1%) under-tolerance.
    booted = await bootEvmOnly({ paymentToleranceUnderBps: 100 });
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("invoice inherits merchant's default under-tolerance and closes as confirmed at 99% paid", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, { amountUsd: "100.00" });
    expect(invoice.paymentToleranceUnderBps).toBe(100);

    // Pay 99 USDC against 100.00 target. Without tolerance this is `partial`;
    // with 1% under-tolerance the threshold drops to 99.00 and we hit confirmed.
    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "11".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "99000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({
        status: invoices.status,
        paid_usd: invoices.paidUsd,
        overpaid_usd: invoices.overpaidUsd
      })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("completed");
    expect(row?.paid_usd).toBe("99.00");
    expect(row?.overpaid_usd).toBe("0");
  });

  it("payments below the under-tolerance band still go to 'partial'", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, { amountUsd: "100.00" });

    // 98 USDC paid — 1% threshold is 99.00, so 98 is still short.
    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "22".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "98000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.invoiceStatusAfter).toBe("processing");
  });
});

describe("payment tolerance — over-payment within band stays 'confirmed' (not 'overpaid')", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    // Merchant default: 100 bps (1%) over-tolerance.
    booted = await bootEvmOnly({ paymentToleranceOverBps: 100 });
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("paid 101% of target → 'confirmed' (within over-tolerance), not 'overpaid'", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, { amountUsd: "100.00" });

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "33".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "101000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({
        status: invoices.status,
        paid_usd: invoices.paidUsd,
        overpaid_usd: invoices.overpaidUsd
      })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("completed");
    expect(row?.paid_usd).toBe("101.00");
    // Even when status is `confirmed`, overpaid_usd stays at 0 because the
    // payment never crossed the over threshold.
    expect(row?.overpaid_usd).toBe("0");
  });

  it("payments past the over-tolerance band still flip to 'overpaid' with raw delta", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, { amountUsd: "100.00" });

    // 105 USDC paid — exceeds the 101 threshold; overpaid status with the
    // RAW delta (5.00) regardless of where the threshold sits.
    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "44".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "105000000" as AmountRaw,
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({ status: invoices.status, extra_status: invoices.extraStatus, overpaid_usd: invoices.overpaidUsd })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("completed");
    expect(row?.extra_status).toBe("overpaid");
    expect(row?.overpaid_usd).toBe("5.00");
  });
});

describe("payment tolerance — per-invoice override beats merchant default", () => {
  let booted: BootedTestApp;
  let apiKey: string;

  beforeEach(async () => {
    // Merchant default 0; the test invoice will set its own override.
    booted = await bootEvmOnly({ paymentToleranceUnderBps: 0, paymentToleranceOverBps: 0 });
    apiKey = booted.apiKeys[MERCHANT_ID]!;
  });

  afterEach(async () => {
    await booted.close();
  });

  it("invoice-level under-tolerance overrides the strict merchant default", async () => {
    const invoice = await createUsdInvoice(booted, apiKey, {
      amountUsd: "2.00",
      paymentToleranceUnderBps: 50 // 0.5% — exactly the user's reported scenario
    });
    expect(invoice.paymentToleranceUnderBps).toBe(50);

    // Pay $1.99 against $2.00. With merchant default (0) this is `partial`;
    // with the per-invoice 0.5% override, threshold becomes $1.99 → confirmed.
    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 1,
      txHash: "0x" + "55".repeat(32),
      logIndex: 0,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "1990000" as AmountRaw, // 1.99 USDC
      blockNumber: 100,
      confirmations: 20,
      seenAt: new Date()
    });
    expect(result.invoiceStatusAfter).toBe("completed");
  });

  it("rejects out-of-range tolerance values at the API boundary", async () => {
    // Cap is 2000 bps (20%); 9999 must fail validation with 400.
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({
          chainId: 1,
          token: "USDC",
          acceptedFamilies: ["evm"],
          amountUsd: "10.00",
          paymentToleranceUnderBps: 9999
        })
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("admin route — PATCH /admin/merchants/:id tolerance updates", () => {
  let booted: BootedTestApp;
  const adminKey = "test-admin-key";

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [evmChainAdapter({ chainIds: [1], transports: { 1: noopTransport } })],
      poolInitialSize: 1,
      secretsOverrides: { ADMIN_KEY: adminKey },
      merchants: [
        { id: MERCHANT_ID, name: "Test Merchant", active: true, paymentToleranceUnderBps: 0 }
      ]
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("updates tolerance fields and echoes the new values", async () => {
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${MERCHANT_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({
          paymentToleranceUnderBps: 50,
          paymentToleranceOverBps: 200
        })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchant: { paymentToleranceUnderBps: number; paymentToleranceOverBps: number };
    };
    expect(body.merchant.paymentToleranceUnderBps).toBe(50);
    expect(body.merchant.paymentToleranceOverBps).toBe(200);

    const [row] = await booted.deps.db
      .select({
        under: merchants.paymentToleranceUnderBps,
        over: merchants.paymentToleranceOverBps
      })
      .from(merchants)
      .where(eq(merchants.id, MERCHANT_ID))
      .limit(1);
    expect(row?.under).toBe(50);
    expect(row?.over).toBe(200);
  });

  it("returns 400 when the body has no updatable fields", async () => {
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${MERCHANT_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({})
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown merchant id", async () => {
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/00000000-0000-0000-0000-deadbeefcafe`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ paymentToleranceUnderBps: 25 })
      })
    );
    expect(res.status).toBe(404);
  });
});
