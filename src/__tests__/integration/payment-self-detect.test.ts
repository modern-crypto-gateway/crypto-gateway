import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import { invoices, payouts, transactions } from "../../db/schema.js";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";
import { SYSTEM_INTERNAL_MERCHANT_ID } from "../../core/domain/pool-consolidation.service.js";
import type { AmountRaw } from "../../core/types/money.js";

const ADMIN_KEY = "super-secret-admin-key";

// Outbound payouts (kind in {standard, gas_top_up, consolidation_sweep,
// gas_burn}) sometimes surface in the inbound detection layer because
// detection scans every transfer touching a watched address. The payouts
// table is the canonical record for those — we MUST NOT also credit them
// to an invoice via the invoice_receive_addresses match.
//
// The bug this regression test locks: when a consolidation_sweep moves
// USDT from sourceA → targetAddress, and targetAddress was previously
// allocated to invoice X, the detection layer non-orphan-matched the
// transfer to invoice X and credited it as if a customer paid. Real-money
// data corruption — merchant's received_amount was inflated, webhooks
// fired for fake "payments". Pre-fix the self-detect guard ran ONLY on
// the orphan branch; post-fix it runs unconditionally.

describe("PaymentService ingest — payout self-detect dedupe", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("skips a transfer whose tx_hash matches one of our standard payouts (orphan path — original behavior preserved)", async () => {
    // Standard merchant payout to an external address. The detection
    // layer would see this as an outbound on the source's address; with
    // no invoice match (toAddress is external), it'd land as an orphan.
    // The self-detect guard skips it — confirmed since this path always
    // worked.
    const merchantId = "00000000-0000-0000-0000-000000000001";
    const now = booted.deps.clock.now().getTime();
    const sharedTxHash = "0xstandardpayout01";

    await booted.deps.db.insert(payouts).values({
      id: "11111111-1111-1111-1111-111111111111",
      merchantId,
      kind: "standard",
      status: "submitted",
      chainId: 999,
      token: "DEV",
      amountRaw: "1000",
      destinationAddress: "0x0000000000000000000000000000000000000099",
      sourceAddress: "0x0000000000000000000000000000000000000001",
      txHash: sharedTxHash,
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    });

    const res = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: sharedTxHash,
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000099",
      token: "DEV" as never,
      amountRaw: "1000" as AmountRaw,
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });

    expect(res.inserted).toBe(false);
    // No transactions row created — payouts table is canonical.
    const txns = await booted.deps.db
      .select()
      .from(transactions)
      .where(eq(transactions.txHash, sharedTxHash));
    expect(txns).toHaveLength(0);
  });

  it("REGRESSION: consolidation_sweep target matching an invoice address must NOT credit the invoice", async () => {
    // The exact bug the user hit. Setup:
    //   1. An invoice exists with receive address = X (allocated from the
    //      pool — so X is in both address_pool and invoice_receive_addresses).
    //   2. A consolidation_sweep payout sweeps tokens from some other
    //      pool address into X.
    //   3. Detection sees "transfer to X", tries to match X to an
    //      invoice, finds the invoice, and (pre-fix) credits it as if a
    //      customer paid.
    //
    // Post-fix: the self-detect guard runs BEFORE the invoice match
    // check, sees that the tx_hash matches a payouts row, and skips
    // ingestion entirely.
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    const targetAddress = invoice.receiveAddress;
    const sweepTxHash = "0xconsolidationsweep01";

    const now = booted.deps.clock.now().getTime();
    await booted.deps.db.insert(payouts).values({
      id: "22222222-2222-2222-2222-222222222222",
      merchantId: SYSTEM_INTERNAL_MERCHANT_ID,
      kind: "consolidation_sweep",
      status: "submitted",
      chainId: 999,
      token: "DEV",
      amountRaw: "5000",
      destinationAddress: targetAddress, // ← target IS the invoice's receive address
      sourceAddress: "0x0000000000000000000000000000000000000abc",
      txHash: sweepTxHash,
      batchId: "33333333-3333-3333-3333-333333333333",
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    });

    const events: string[] = [];
    booted.deps.events.subscribeAll((e) => { events.push(e.type); });

    const res = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: sweepTxHash,
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000abc",
      toAddress: targetAddress,
      token: "DEV" as never,
      amountRaw: "5000" as AmountRaw,
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });

    // CRITICAL: ingest is skipped. Pre-fix this would have returned
    // { inserted: true, invoiceId: invoice.id }.
    expect(res.inserted).toBe(false);
    expect(res.invoiceId).toBeUndefined();

    // No transactions row — the payouts table is the canonical record.
    const txns = await booted.deps.db
      .select()
      .from(transactions)
      .where(eq(transactions.txHash, sweepTxHash));
    expect(txns).toHaveLength(0);

    // Invoice's received_amount must NOT have moved. Pre-fix this would
    // have been "5000" (or the invoice would have flipped to completed).
    const [inv] = await booted.deps.db
      .select({ receivedAmountRaw: invoices.receivedAmountRaw, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(inv?.receivedAmountRaw).toBe("0");
    expect(inv?.status).toBe("pending");

    // No fake payment events fired.
    expect(events).not.toContain("invoice.payment_detected");
    expect(events).not.toContain("invoice.payment_confirmed");
    expect(events).not.toContain("invoice.completed");
    expect(events).not.toContain("tx.detected");
  });

  it("REGRESSION: gas_top_up tx whose destination is a pool-reused invoice address must NOT credit the invoice", async () => {
    // Same shape as the consolidation case but with gas_top_up. The
    // sponsor sends native to a source address; if that source was
    // previously an invoice receive address, pre-fix the gas-top-up
    // tx would credit the invoice with native tokens.
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    const sourceAddress = invoice.receiveAddress;
    const topUpTxHash = "0xgastopup01";

    const now = booted.deps.clock.now().getTime();
    await booted.deps.db.insert(payouts).values({
      id: "44444444-4444-4444-4444-444444444444",
      merchantId: "00000000-0000-0000-0000-000000000001",
      kind: "gas_top_up",
      status: "submitted",
      chainId: 999,
      token: "DEV",
      amountRaw: "100",
      destinationAddress: sourceAddress,
      sourceAddress: "0x0000000000000000000000000000000000000def",
      txHash: topUpTxHash,
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    });

    const res = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: topUpTxHash,
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000def",
      toAddress: sourceAddress,
      token: "DEV" as never,
      amountRaw: "100" as AmountRaw,
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });

    expect(res.inserted).toBe(false);

    const [inv] = await booted.deps.db
      .select({ receivedAmountRaw: invoices.receivedAmountRaw })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(inv?.receivedAmountRaw).toBe("0");
  });

  it("real customer payment to an invoice address (no matching payout) ingests normally", async () => {
    // Sanity: the self-detect guard must NOT block legitimate inbound
    // customer payments. txHash has no matching payouts row → ingest
    // proceeds, invoice gets credited.
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    const customerTxHash = "0xrealcustomerpayment01";

    const res = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: customerTxHash,
      logIndex: 0,
      fromAddress: "0xcafe000000000000000000000000000000000000",
      toAddress: invoice.receiveAddress,
      token: "DEV" as never,
      amountRaw: "1000" as AmountRaw,
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });

    expect(res.inserted).toBe(true);
    expect(res.invoiceId).toBe(invoice.id);

    const [txn] = await booted.deps.db
      .select({ invoiceId: transactions.invoiceId, status: transactions.status })
      .from(transactions)
      .where(eq(transactions.txHash, customerTxHash))
      .limit(1);
    expect(txn?.invoiceId).toBe(invoice.id);
    expect(txn?.status).toBe("confirmed");
  });
});
