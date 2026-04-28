import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { custom } from "viem";
import { evmChainAdapter } from "../../adapters/chains/evm/evm-chain.adapter.js";
import { merchants as merchantsTable, invoices as invoicesTable } from "../../db/schema.js";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";

// Per-merchant confirmation-threshold overrides snapshot at invoice create
// time. These tests pin the contract:
//   1. Merchant with no override → invoice snapshots the gateway default for
//      its chainId.
//   2. Merchant with `{"1": 1}` → chainId=1 invoice snapshots 1.
//   3. Merchant override change AFTER invoice creation → the existing
//      invoice's snapshotted threshold stays at its create-time value
//      (frozen-at-create discipline, mirrors payment-tolerance pattern).
//   4. Multi-family invoices: the single merchant override for the primary
//      chainId is the value applied across every accepted family — tested
//      against an EVM-primary invoice with no UTXO chain in deps.chains
//      so the focus is just the snapshot value, not the per-leg routing.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

const noopTransport = custom({
  async request() {
    throw new Error("EVM adapter touched RPC unexpectedly");
  }
});

describe("merchant confirmation threshold snapshot", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({
      chains: [evmChainAdapter({ chainIds: [1, 137], transports: { 1: noopTransport, 137: noopTransport } })]
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function setMerchantOverride(json: string | null): Promise<void> {
    await booted.deps.db
      .update(merchantsTable)
      .set({ confirmationThresholdsJson: json, updatedAt: Date.now() })
      .where(eq(merchantsTable.id, MERCHANT_ID));
  }

  async function readInvoiceThreshold(invoiceId: string): Promise<number | null> {
    const [row] = await booted.deps.db
      .select({ ct: invoicesTable.confirmationThreshold })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    return row?.ct ?? null;
  }

  it("merchant with NO override → invoice snapshots the gateway default for the chainId", async () => {
    // Default for chainId 1 is 12 per DEFAULT_CONFIRMATION_THRESHOLDS.
    await setMerchantOverride(null);
    const invoice = await createInvoiceViaApi(booted, {
      chainId: 1,
      token: "USDC",
      amountRaw: "1000000"
    });
    expect(await readInvoiceThreshold(invoice.id)).toBe(12);
  });

  it("merchant with override on chainId 1 → invoice snapshots that value", async () => {
    await setMerchantOverride(JSON.stringify({ "1": 1 })); // low-risk merchant
    const invoice = await createInvoiceViaApi(booted, {
      chainId: 1,
      token: "USDC",
      amountRaw: "1000000"
    });
    expect(await readInvoiceThreshold(invoice.id)).toBe(1);
  });

  it("merchant with override on a DIFFERENT chainId → invoice on chainId 137 snapshots the gateway default for 137", async () => {
    await setMerchantOverride(JSON.stringify({ "1": 1 })); // only chainId 1 overridden
    const invoice = await createInvoiceViaApi(booted, {
      chainId: 137,
      token: "USDC",
      amountRaw: "1000000"
    });
    // Polygon default is 256 per DEFAULT_CONFIRMATION_THRESHOLDS — merchant
    // didn't override it, so we use the default.
    expect(await readInvoiceThreshold(invoice.id)).toBe(256);
  });

  it("snapshot is FROZEN at create time — merchant override changes after creation don't reshape the invoice", async () => {
    await setMerchantOverride(JSON.stringify({ "1": 1 }));
    const earlyInvoice = await createInvoiceViaApi(booted, {
      chainId: 1,
      token: "USDC",
      amountRaw: "1000000"
    });
    expect(await readInvoiceThreshold(earlyInvoice.id)).toBe(1);

    // Merchant raises their threshold to 100. The earlier invoice MUST keep
    // its snapshotted 1 — frozen at create time. New invoices get the 100.
    await setMerchantOverride(JSON.stringify({ "1": 100 }));
    const lateInvoice = await createInvoiceViaApi(booted, {
      chainId: 1,
      token: "USDC",
      amountRaw: "1000000"
    });
    expect(await readInvoiceThreshold(earlyInvoice.id)).toBe(1); // unchanged
    expect(await readInvoiceThreshold(lateInvoice.id)).toBe(100);
  });

  it("merchant clears override (back to null) → subsequent invoices snapshot the gateway default", async () => {
    await setMerchantOverride(JSON.stringify({ "1": 1 }));
    const a = await createInvoiceViaApi(booted, { chainId: 1, token: "USDC", amountRaw: "1000000" });
    expect(await readInvoiceThreshold(a.id)).toBe(1);

    await setMerchantOverride(null);
    const b = await createInvoiceViaApi(booted, { chainId: 1, token: "USDC", amountRaw: "1000000" });
    expect(await readInvoiceThreshold(b.id)).toBe(12);
  });
});
