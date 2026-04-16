import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { ingestDetectedTransfer, confirmTransactions } from "../../core/domain/payment.service.js";
import { bootTestApp, createOrderViaApi, type BootedTestApp } from "../helpers/boot.js";

// Shim around the shared helper for this file's previous call sites.
async function createOrder(
  booted: BootedTestApp,
  opts: { amountRaw: string; token?: string; chainId?: number }
): Promise<{ id: string; receiveAddress: string }> {
  return createOrderViaApi(booted, {
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

  it("promotes order to 'detected' when a matching transfer covers the required amount", async () => {
    const order = await createOrder(booted, { amountRaw: "1000000" });
    const events: string[] = [];
    booted.deps.events.subscribeAll((e) => { events.push(e.type); });

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: order.receiveAddress,
      token: "DEV",
      amountRaw: "1000000",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });

    expect(result.inserted).toBe(true);
    expect(result.orderStatusBefore).toBe("created");
    expect(result.orderStatusAfter).toBe("detected");
    expect(events).toContain("tx.detected");
    expect(events).toContain("order.detected");

    // Verify persisted row
    const row = await booted.deps.db
      .prepare("SELECT status, received_amount_raw FROM orders WHERE id = ?")
      .bind(order.id)
      .first<{ status: string; received_amount_raw: string }>();
    expect(row?.status).toBe("detected");
    expect(row?.received_amount_raw).toBe("1000000");
  });

  it("moves order to 'partial' on underpayment, then to 'detected' on a second transfer that covers the balance", async () => {
    const order = await createOrder(booted, { amountRaw: "1000" });

    const r1 = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: order.receiveAddress,
      token: "DEV",
      amountRaw: "400",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });
    expect(r1.orderStatusAfter).toBe("partial");

    const r2 = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc2",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000002",
      toAddress: order.receiveAddress,
      token: "DEV",
      amountRaw: "700",
      blockNumber: 101,
      confirmations: 0,
      seenAt: new Date()
    });
    expect(r2.orderStatusAfter).toBe("detected");

    const row = await booted.deps.db
      .prepare("SELECT received_amount_raw FROM orders WHERE id = ?")
      .bind(order.id)
      .first<{ received_amount_raw: string }>();
    // 400 + 700 = 1100 (overpayment is accepted)
    expect(row?.received_amount_raw).toBe("1100");
  });

  it("goes straight to 'detected' with a single immediately-confirmed transfer (above threshold)", async () => {
    // dev chain threshold is 1; confirmations=5 => tx status='confirmed' on insert.
    const order = await createOrder(booted, { amountRaw: "1000" });

    const result = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc3",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: order.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });

    // One tx, immediately confirmed, covers the full amount -> order goes to confirmed.
    expect(result.orderStatusAfter).toBe("confirmed");

    const row = await booted.deps.db
      .prepare("SELECT confirmed_at FROM orders WHERE id = ?")
      .bind(order.id)
      .first<{ confirmed_at: number }>();
    expect(row?.confirmed_at).toBeGreaterThan(0);
  });

  it("is idempotent: ingesting the same (chainId, txHash, logIndex) twice returns inserted=false", async () => {
    const order = await createOrder(booted, { amountRaw: "1000" });

    const r1 = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xabc4",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: order.receiveAddress,
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
      toAddress: order.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 0,
      seenAt: new Date()
    });

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);

    // Only one transactions row should exist for this hash.
    const count = await booted.deps.db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE tx_hash = ?")
      .bind("0xabc4")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("records orphan transfers (no matching order) with order_id = NULL", async () => {
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
    expect(result.orderId).toBeUndefined();

    const row = await booted.deps.db
      .prepare("SELECT order_id FROM transactions WHERE tx_hash = ?")
      .bind("0xdeadbeef")
      .first<{ order_id: string | null }>();
    expect(row?.order_id).toBeNull();
  });
});

describe("PaymentService.confirmTransactions", () => {
  it("promotes detected txs to confirmed and bumps orders from detected to confirmed", async () => {
    // Boot with a shared Map so we can mutate the chain adapter's responses
    // between the initial ingest and the sweep.
    const confirmations = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    const booted = await bootTestApp({
      chains: [devChainAdapter({ confirmationStatuses: confirmations })]
    });

    try {
      const order = await createOrder(booted, { amountRaw: "1000" });

      // Ingest with 0 confirmations -> tx status='detected', order status='detected'
      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xsweep1",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: order.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 100,
        confirmations: 0,
        seenAt: new Date()
      });

      const beforeSweep = await booted.deps.db
        .prepare("SELECT status FROM orders WHERE id = ?")
        .bind(order.id)
        .first<{ status: string }>();
      expect(beforeSweep?.status).toBe("detected");

      // Now tell the chain adapter this tx has enough confirmations.
      confirmations.set("0xsweep1", { blockNumber: 110, confirmations: 5, reverted: false });

      const events: string[] = [];
      booted.deps.events.subscribeAll((e) => { events.push(e.type); });

      const sweep = await confirmTransactions(booted.deps);
      expect(sweep.checked).toBe(1);
      expect(sweep.confirmed).toBe(1);
      expect(sweep.promotedOrders).toBe(1);

      const afterSweep = await booted.deps.db
        .prepare("SELECT status, confirmed_at FROM orders WHERE id = ?")
        .bind(order.id)
        .first<{ status: string; confirmed_at: number | null }>();
      expect(afterSweep?.status).toBe("confirmed");
      expect(afterSweep?.confirmed_at).not.toBeNull();

      expect(events).toContain("tx.confirmed");
      expect(events).toContain("order.confirmed");
    } finally {
      await booted.close();
    }
  });

  it("flags reverted txs and excludes them from the order's received total", async () => {
    const confirmations = new Map<string, { blockNumber: number | null; confirmations: number; reverted: boolean }>();
    const booted = await bootTestApp({
      chains: [devChainAdapter({ confirmationStatuses: confirmations })]
    });

    try {
      const order = await createOrder(booted, { amountRaw: "1000" });

      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xrevert1",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: order.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 100,
        confirmations: 0,
        seenAt: new Date()
      });
      // Order is now 'detected' with received=1000.

      confirmations.set("0xrevert1", { blockNumber: 110, confirmations: 5, reverted: true });

      const sweep = await confirmTransactions(booted.deps);
      expect(sweep.reverted).toBe(1);

      const txRow = await booted.deps.db
        .prepare("SELECT status FROM transactions WHERE tx_hash = ?")
        .bind("0xrevert1")
        .first<{ status: string }>();
      expect(txRow?.status).toBe("reverted");

      // Reverted tx no longer contributes -> total drops to 0. The order re-opens
      // (moves back to 'created') so new payments can still satisfy it before
      // the expiry window elapses.
      const orderRow = await booted.deps.db
        .prepare("SELECT status, received_amount_raw FROM orders WHERE id = ?")
        .bind(order.id)
        .first<{ status: string; received_amount_raw: string }>();
      expect(orderRow?.received_amount_raw).toBe("0");
      expect(orderRow?.status).toBe("created");
    } finally {
      await booted.close();
    }
  });
});
