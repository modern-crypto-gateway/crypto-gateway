import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { invoices, transactions } from "../../db/schema.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { ingestDetectedTransfer, confirmTransactions } from "../../core/domain/payment.service.js";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";

// Shim around the shared helper for this file's previous call sites.
async function createInvoice(
  booted: BootedTestApp,
  opts: { amountRaw: string; token?: string; chainId?: number }
): Promise<{ id: string; receiveAddress: string }> {
  return createInvoiceViaApi(booted, {
    amountRaw: opts.amountRaw,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.chainId !== undefined ? { chainId: opts.chainId } : {})
  });
}

describe("PaymentService.ingestDetectedTransfer", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp();
  });

  afterEach(async () => {
    await booted.close();
  });

  it("promotes invoice to 'detected' when a matching transfer covers the required amount", async () => {
    const invoice = await createInvoice(booted, { amountRaw: "1000000" });
    const events: string[] = [];
    booted.deps.events.subscribeAll((e) => { events.push(e.type); });

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000000",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });

    expect(result.inserted).toBe(true);
    expect(result.invoiceStatusBefore).toBe("pending");
    // Full required amount seen but unconfirmed → status moves to processing
    // (the new model collapses the old `detected` and `partial` into the
    // single `processing` lifecycle stage; the unconfirmed-but-full case has
    // extra_status=null since the amount is fine, just awaiting confirmations).
    expect(result.invoiceStatusAfter).toBe("processing");
    expect(events).toContain("tx.detected");
    // No invoice-lifecycle event for pending→processing — per-tx
    // invoice.payment_detected carries the visibility instead.
    expect(events).toContain("invoice.payment_detected");

    // Verify persisted row
    const [row] = await booted.deps.db
      .select({ status: invoices.status, received_amount_raw: invoices.receivedAmountRaw })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.status).toBe("processing");
    expect(row?.received_amount_raw).toBe("1000000");
  });

  it("moves invoice to 'processing' (extra='partial') on underpayment, then to 'processing' (extra=null) when a second transfer covers the balance", async () => {
    const invoice = await createInvoice(booted, { amountRaw: "1000" });

    const r1 = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "400",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });
    // Underpayment → processing (with extra_status='partial' on the row).
    expect(r1.invoiceStatusAfter).toBe("processing");

    const r2 = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc2",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000002",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "700",
      blockNumber: 101,
      confirmations: 0,
      seenAt: new Date()
    });
    // Second transfer covers the balance — full amount seen but unconfirmed,
    // so still `processing` with extra=null (the old `detected` status).
    expect(r2.invoiceStatusAfter).toBe("processing");

    const [row] = await booted.deps.db
      .select({ received_amount_raw: invoices.receivedAmountRaw })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    // 400 + 700 = 1100 (overpayment is accepted)
    expect(row?.received_amount_raw).toBe("1100");
  });

  it("goes straight to 'completed' with a single immediately-confirmed transfer (above threshold)", async () => {
    // dev chain threshold is 1; confirmations=5 => tx status='confirmed' on insert.
    const invoice = await createInvoice(booted, { amountRaw: "1000" });

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc3",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });

    // One tx, immediately confirmed, covers the full amount -> invoice goes to completed.
    expect(result.invoiceStatusAfter).toBe("completed");

    const [row] = await booted.deps.db
      .select({ confirmed_at: invoices.confirmedAt })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(row?.confirmed_at ?? 0).toBeGreaterThan(0);
  });

  it("is idempotent: ingesting the same (chainId, txHash, logIndex) twice returns inserted=false", async () => {
    const invoice = await createInvoice(booted, { amountRaw: "1000" });

    const r1 = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc4",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });
    const r2 = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc4",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);

    // Only one transactions row should exist for this hash.
    const [count] = await booted.deps.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(transactions)
      .where(eq(transactions.txHash, "0xabc4"));
    expect(Number(count?.n)).toBe(1);
  });

  it("records orphan transfers (no matching invoice) with invoice_id = NULL", async () => {
    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xdeadbeef",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000099",
      token: "DEV",
      amountRaw: "500",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });

    expect(result.inserted).toBe(true);
    expect(result.invoiceId).toBeUndefined();

    const [row] = await booted.deps.db
      .select({ invoice_id: transactions.invoiceId })
      .from(transactions)
      .where(eq(transactions.txHash, "0xdeadbeef"))
      .limit(1);
    expect(row?.invoice_id).toBeNull();
  });

  it("does NOT credit a wrong-token transfer toward a single-token invoice (Alchemy webhook fans out all native+ERC-20 activity at the address)", async () => {
    // Single-token invoice: 1 DEV @ 6 decimals = "1000000".
    const invoice = await createInvoice(booted, { amountRaw: "1000000" });

    // Wrong token at the same address — would happen if a user sent ETH/USDC
    // to a USDC invoice's receive address and the Alchemy webhook pushed
    // all activity. Amount is huge in raw units (more than the DEV target)
    // so a unit-blind sum would wrongly confirm the invoice.
    const wrongTokenResult = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xwrong",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "USDC",
      amountRaw: "999999999999999999999",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });
    // The tx still gets recorded and linked to the invoice for audit, but the
    // invoice MUST stay in `pending` (no credit toward the DEV-denominated
    // total) and `received_amount_raw` MUST stay 0.
    expect(wrongTokenResult.inserted).toBe(true);
    expect(wrongTokenResult.invoiceStatusBefore).toBe("pending");
    expect(wrongTokenResult.invoiceStatusAfter).toBe("pending");

    const [invoiceRow] = await booted.deps.db
      .select({ status: invoices.status, received: invoices.receivedAmountRaw })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(invoiceRow?.status).toBe("pending");
    expect(invoiceRow?.received).toBe("0");

    // Audit row exists with the invoice link — operator can still see what landed.
    const [auditRow] = await booted.deps.db
      .select({ invoice_id: transactions.invoiceId, token: transactions.token })
      .from(transactions)
      .where(eq(transactions.txHash, "0xwrong"))
      .limit(1);
    expect(auditRow?.invoice_id).toBe(invoice.id);
    expect(auditRow?.token).toBe("USDC");

    // Now the matching-token transfer covers the invoice — it should confirm
    // (well, detect — confirmation comes via the cron). The presence of the
    // earlier wrong-token row must not interfere.
    const correctResult = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xcorrect",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000000",
      blockNumber: 101,
      confirmations: 0,
      seenAt: new Date()
    });
    expect(correctResult.invoiceStatusAfter).toBe("processing");

    const [afterRow] = await booted.deps.db
      .select({ status: invoices.status, received: invoices.receivedAmountRaw })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(afterRow?.status).toBe("processing");
    expect(afterRow?.received).toBe("1000000");
  });
});

describe("PaymentService.confirmTransactions", () => {
  it("promotes detected txs to confirmed and bumps invoices from processing to completed", async () => {
    // Boot with a shared Map so we can mutate the chain adapter's responses
    // between the initial ingest and the sweep.
    const confirmations = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    const booted = await bootTestApp({
      chains: [devChainAdapter({ confirmationStatuses: confirmations })]
    });

    try {
      const invoice = await createInvoice(booted, { amountRaw: "1000" });

      // Ingest with 0 confirmations -> tx status='detected', invoice status='processing'
      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xsweep1",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 100,
        confirmations: 0,
        seenAt: new Date()
      });

      const [beforeSweep] = await booted.deps.db
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      expect(beforeSweep?.status).toBe("processing");

      // Now tell the chain adapter this tx has enough confirmations.
      confirmations.set("0xsweep1", { blockNumber: 110, confirmations: 5, reverted: false });

      const events: string[] = [];
      booted.deps.events.subscribeAll((e) => { events.push(e.type); });

      const sweep = await confirmTransactions(booted.deps);
      expect(sweep.checked).toBe(1);
      expect(sweep.confirmed).toBe(1);
      expect(sweep.promotedInvoices).toBe(1);

      const [afterSweep] = await booted.deps.db
        .select({ status: invoices.status, confirmed_at: invoices.confirmedAt })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      expect(afterSweep?.status).toBe("completed");
      expect(afterSweep?.confirmed_at).not.toBeNull();

      expect(events).toContain("tx.confirmed");
      expect(events).toContain("invoice.completed");
    } finally {
      await booted.close();
    }
  });

  it("flags reverted txs and excludes them from the invoice's received total", async () => {
    const confirmations = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    const booted = await bootTestApp({
      chains: [devChainAdapter({ confirmationStatuses: confirmations })]
    });

    try {
      const invoice = await createInvoice(booted, { amountRaw: "1000" });

      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xrevert1",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 100,
        confirmations: 0,
        seenAt: new Date()
      });
      // Invoice is now 'detected' with received=1000.

      confirmations.set("0xrevert1", { blockNumber: 110, confirmations: 5, reverted: true });

      const sweep = await confirmTransactions(booted.deps);
      expect(sweep.reverted).toBe(1);

      const [txRow] = await booted.deps.db
        .select({ status: transactions.status })
        .from(transactions)
        .where(eq(transactions.txHash, "0xrevert1"))
        .limit(1);
      expect(txRow?.status).toBe("reverted");

      // Reverted tx no longer contributes -> total drops to 0. The invoice re-opens
      // (moves back to 'pending') so new payments can still satisfy it before
      // the expiry window elapses.
      const [invoiceRow] = await booted.deps.db
        .select({ status: invoices.status, received_amount_raw: invoices.receivedAmountRaw })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      expect(invoiceRow?.received_amount_raw).toBe("0");
      expect(invoiceRow?.status).toBe("pending");
    } finally {
      await booted.close();
    }
  });
});
