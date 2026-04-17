import { describe, expect, it } from "vitest";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { rpcPollDetection } from "../../adapters/detection/rpc-poll.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import { pollPayments } from "../../core/domain/poll-payments.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

async function createInvoice(
  booted: BootedTestApp,
  amountRaw: string
): Promise<{ id: string; receiveAddress: string }> {
  return createInvoiceViaApi(booted, { amountRaw });
}

describe("end-to-end: invoice.detected -> webhook dispatched", () => {
  it("delivers a webhook to the merchant URL when an invoice is promoted to detected", async () => {
    const booted = await bootTestApp({
      merchants: [
        {
          id: MERCHANT_ID,
          name: "Hooked Merchant",
          webhookUrl: "https://merchant.example.com/hook",
          webhookSecret: "b".repeat(64)
        }
      ]
    });
    try {
      const invoice = await createInvoice(booted, "1000");

      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xhook1",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 10,
        confirmations: 0,
        seenAt: new Date()
      });

      // Dispatch is deferred via deps.jobs.defer; drain to flush.
      await booted.deps.jobs.drain(1_000);

      const calls = booted.webhookDispatcher!.calls;
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toBe("https://merchant.example.com/hook");
      expect(call.secret).toBe("b".repeat(64));
      expect(call.idempotencyKey).toBe(`invoice.detected:${invoice.id}:detected`);
      const payload = call.payload as { event: string; data: { id: string; status: string } };
      expect(payload.event).toBe("invoice.detected");
      expect(payload.data.id).toBe(invoice.id);
      expect(payload.data.status).toBe("detected");
    } finally {
      await booted.close();
    }
  });

  it("silently skips dispatch when the merchant has no webhook_url", async () => {
    const booted = await bootTestApp();
    try {
      const invoice = await createInvoice(booted, "1000");
      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xhook2",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 10,
        confirmations: 0,
        seenAt: new Date()
      });
      await booted.deps.jobs.drain(1_000);
      expect(booted.webhookDispatcher!.calls).toHaveLength(0);
    } finally {
      await booted.close();
    }
  });

  it("does not fire for internal events (invoice.created, tx.detected)", async () => {
    const booted = await bootTestApp({
      merchants: [
        {
          id: MERCHANT_ID,
          webhookUrl: "https://merchant.example.com/hook",
          webhookSecret: "b".repeat(64)
        }
      ]
    });
    try {
      // Creating an invoice emits invoice.created + tx.detected via later ingest,
      // but neither should produce a webhook call.
      const invoice = await createInvoice(booted, "10");
      await booted.deps.jobs.drain(200);
      expect(booted.webhookDispatcher!.calls).toHaveLength(0);

      // A partial-payment transfer (< requiredAmount) emits invoice.partial + tx.detected.
      // Of those, only invoice.partial is merchant-visible.
      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xhook3",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "5",
        blockNumber: 10,
        confirmations: 0,
        seenAt: new Date()
      });
      await booted.deps.jobs.drain(1_000);

      const calls = booted.webhookDispatcher!.calls;
      expect(calls).toHaveLength(1);
      expect((calls[0]!.payload as { event: string }).event).toBe("invoice.partial");
    } finally {
      await booted.close();
    }
  });
});

describe("pollPayments orchestrator", () => {
  it("hands transfers from each chain's DetectionStrategy to ingestDetectedTransfer", async () => {
    // Shared mutable array the test populates after the invoice is created.
    // The dev adapter captures it by reference, so updates flow through.
    const incoming: DetectedTransfer[] = [];
    const chain = devChainAdapter({ incomingTransfers: incoming });

    const booted = await bootTestApp({
      chains: [chain],
      detectionStrategies: { 999: rpcPollDetection() }
    });
    try {
      const invoice = await createInvoice(booted, "1000");

      incoming.push({
        chainId: 999,
        txHash: "0xpoll1",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 10,
        confirmations: 0,
        seenAt: new Date()
      });

      const result = await pollPayments(booted.deps);
      expect(result.chainsPolled).toBe(1);
      expect(result.addressesWatched).toBe(1);
      expect(result.transfersFound).toBe(1);
      expect(result.transfersIngested).toBe(1);

      const txRow = await booted.deps.db
        .prepare("SELECT COUNT(*) AS n FROM transactions WHERE tx_hash = ?")
        .bind("0xpoll1")
        .first<{ n: number }>();
      expect(txRow?.n).toBe(1);
    } finally {
      await booted.close();
    }
  });

  it("returns zero counts when no invoices are active", async () => {
    const booted = await bootTestApp({
      chains: [devChainAdapter()],
      detectionStrategies: { 999: rpcPollDetection() }
    });
    try {
      const result = await pollPayments(booted.deps);
      expect(result).toEqual({
        chainsPolled: 0,
        addressesWatched: 0,
        transfersFound: 0,
        transfersIngested: 0,
        duplicates: 0
      });
    } finally {
      await booted.close();
    }
  });

  it("treats repeated polls over the same transfer as duplicates", async () => {
    const incoming: DetectedTransfer[] = [];
    const chain = devChainAdapter({ incomingTransfers: incoming });
    const booted = await bootTestApp({
      chains: [chain],
      detectionStrategies: { 999: rpcPollDetection() }
    });
    try {
      const invoice = await createInvoice(booted, "1000");
      incoming.push({
        chainId: 999,
        txHash: "0xpoll-dup",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 10,
        confirmations: 0,
        seenAt: new Date()
      });
      const r1 = await pollPayments(booted.deps);
      expect(r1.transfersIngested).toBe(1);
      expect(r1.duplicates).toBe(0);

      // Second call sees the same transfer (adapter is memoryless), and the
      // UNIQUE index on (chain_id, tx_hash, log_index) rejects the insert.
      const r2 = await pollPayments(booted.deps);
      expect(r2.transfersIngested).toBe(0);
      expect(r2.duplicates).toBe(1);
    } finally {
      await booted.close();
    }
  });
});
