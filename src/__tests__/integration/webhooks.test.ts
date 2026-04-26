import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { transactions } from "../../db/schema.js";
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

describe("end-to-end: invoice:payment_detected -> webhook dispatched", () => {
  it("delivers a webhook to the merchant URL when an unconfirmed transfer arrives", async () => {
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

      // One webhook per unconfirmed ingest: invoice:payment_detected (per-tx).
      // The lifecycle transition pending→processing has no separate event —
      // per-tx events carry merchant visibility for that phase.
      const calls = booted.webhookDispatcher!.calls;
      expect(calls).toHaveLength(1);
      const transferCall = calls[0]!;
      expect(transferCall.url).toBe("https://merchant.example.com/hook");
      expect(transferCall.secret).toBe("b".repeat(64));
      const payload = transferCall.payload as {
        event: string;
        data: { invoice: { id: string; status: string; extraStatus: string | null }; triggerTxHash: string | null };
      };
      expect(payload.event).toBe("invoice:payment_detected");
      expect(payload.data.invoice.id).toBe(invoice.id);
      expect(payload.data.invoice.status).toBe("processing");
      expect(payload.data.triggerTxHash).toBe("0xhook1");
      expect(transferCall.idempotencyKey).toBe(`invoice:payment_detected:${invoice.id}:0xhook1`);
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

  it("uses per-invoice webhook override when one is set on the invoice", async () => {
    const booted = await bootTestApp({
      merchants: [
        {
          id: MERCHANT_ID,
          webhookUrl: "https://merchant.example.com/default",
          webhookSecret: "m".repeat(64)
        }
      ]
    });
    try {
      const invoice = await createInvoiceViaApi(booted, {
        amountRaw: "1000",
        webhookUrl: "https://merchant.example.com/per-invoice",
        webhookSecret: "i".repeat(64)
      });
      // Per-invoice URL is echoed; the secret is not (write-only).
      expect(invoice["webhookUrl"]).toBe("https://merchant.example.com/per-invoice");
      expect(invoice).not.toHaveProperty("webhookSecret");
      expect(invoice).not.toHaveProperty("webhookSecretCiphertext");

      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xperinvoice",
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

      // One webhook per unconfirmed ingest (invoice:payment_detected); routed
      // to the per-invoice URL with the per-invoice secret — merchant default
      // ignored because the override took precedence.
      const calls = booted.webhookDispatcher!.calls;
      expect(calls).toHaveLength(1);
      for (const c of calls) {
        expect(c.url).toBe("https://merchant.example.com/per-invoice");
        expect(c.secret).toBe("i".repeat(64));
      }
    } finally {
      await booted.close();
    }
  });

  it("falls back to the merchant webhook when the invoice has no override", async () => {
    const booted = await bootTestApp({
      merchants: [
        {
          id: MERCHANT_ID,
          webhookUrl: "https://merchant.example.com/default",
          webhookSecret: "m".repeat(64)
        }
      ]
    });
    try {
      // No webhookUrl/webhookSecret on the invoice — merchant default kicks in.
      const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
      expect(invoice["webhookUrl"]).toBeNull();

      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xfallback",
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

      // One webhook per unconfirmed ingest; falls back to the merchant default
      // URL/secret since the invoice has no override.
      const calls = booted.webhookDispatcher!.calls;
      expect(calls).toHaveLength(1);
      for (const c of calls) {
        expect(c.url).toBe("https://merchant.example.com/default");
        expect(c.secret).toBe("m".repeat(64));
      }
    } finally {
      await booted.close();
    }
  });

  it("uses the per-invoice webhook even when the merchant has no default", async () => {
    // No merchant-level webhook; only the invoice-level override exists.
    const booted = await bootTestApp();
    try {
      const invoice = await createInvoiceViaApi(booted, {
        amountRaw: "1000",
        webhookUrl: "https://merchant.example.com/only-invoice",
        webhookSecret: "i".repeat(64)
      });

      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xonlyinvoice",
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

      // One webhook per unconfirmed ingest; goes to the per-invoice URL since
      // no merchant default exists.
      const calls = booted.webhookDispatcher!.calls;
      expect(calls).toHaveLength(1);
      for (const c of calls) {
        expect(c.url).toBe("https://merchant.example.com/only-invoice");
        expect(c.secret).toBe("i".repeat(64));
      }
    } finally {
      await booted.close();
    }
  });

  it("rejects an invoice that supplies webhookUrl without webhookSecret (paired)", async () => {
    const booted = await bootTestApp();
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const res = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            chainId: 999,
            token: "DEV",
            amountRaw: "1000",
            webhookUrl: "https://merchant.example.com/half"
            // webhookSecret intentionally omitted — schema must reject.
          })
        })
      );
      expect(res.status).toBe(400);
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

      // A partial-payment transfer (< requiredAmount) emits tx.detected and
      // invoice.payment_detected internally. Only the latter is merchant-
      // facing → exactly one webhook; tx.detected is internal-only.
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
      const events = calls.map((c) => (c.payload as { event: string }).event);
      expect(events).toEqual(["invoice:payment_detected"]);
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

      const [txRow] = await booted.deps.db
        .select({ n: sql<number>`COUNT(*)` })
        .from(transactions)
        .where(eq(transactions.txHash, "0xpoll1"));
      expect(Number(txRow?.n)).toBe(1);
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

  // Regression: prior to wiring registerEventSubscribers into the Workers
  // `scheduled` handler, events published from inside `confirmTransactions`
  // (and any other cron sweeper) reached an empty bus and never inserted
  // into webhook_deliveries — operators saw `invoice:payment_detected`
  // (fired from the HTTP-ingest path, which goes through buildApp) but no
  // `invoice:completed` or `invoice:payment_confirmed`. This test exercises
  // the same shape: ingest at conf=0, then promote via the cron sweeper,
  // and assert BOTH the lifecycle webhook AND the per-transfer-confirmed
  // webhook fire.
  it("dispatches invoice:completed AND invoice:payment_confirmed when the cron sweeper promotes a tx", async () => {
    const { confirmTransactions } = await import("../../core/domain/payment.service.js");
    const confirmations = new Map<
      string,
      { blockNumber: number | null; confirmations: number; reverted: boolean }
    >();
    const booted = await bootTestApp({
      merchants: [
        {
          id: MERCHANT_ID,
          webhookUrl: "https://merchant.example.com/hook",
          webhookSecret: "c".repeat(64)
        }
      ],
      chains: [devChainAdapter({ confirmationStatuses: confirmations })]
    });
    try {
      const invoice = await createInvoice(booted, "1000");

      await ingestDetectedTransfer(booted.deps, {
        chainId: 999,
        txHash: "0xpromote",
        logIndex: 0,
        fromAddress: "0x0000000000000000000000000000000000000001",
        toAddress: invoice.receiveAddress,
        token: "DEV",
        amountRaw: "1000",
        blockNumber: 100,
        confirmations: 0,
        seenAt: new Date()
      });
      await booted.deps.jobs.drain(1_000);

      // After ingest: only invoice:payment_detected (per-tx). The lifecycle
      // pending→processing has no separate event in the new model.
      const initialEvents = booted.webhookDispatcher!.calls.map(
        (c) => (c.payload as { event: string }).event
      );
      expect(initialEvents).toEqual(["invoice:payment_detected"]);

      // Now mark the tx confirmed on-chain and run the cron sweeper. THIS is
      // the path that was silently dropping events on Workers `scheduled`.
      confirmations.set("0xpromote", { blockNumber: 110, confirmations: 5, reverted: false });
      await confirmTransactions(booted.deps);
      await booted.deps.jobs.drain(1_000);

      const allEvents = booted.webhookDispatcher!.calls.map(
        (c) => (c.payload as { event: string }).event
      );
      // Promotion adds invoice:completed (lifecycle) + invoice:payment_confirmed (per-tx).
      expect(allEvents).toContain("invoice:completed");
      expect(allEvents).toContain("invoice:payment_confirmed");

      const completedCall = booted.webhookDispatcher!.calls.find(
        (c) => (c.payload as { event: string }).event === "invoice:completed"
      )!;
      expect(completedCall.idempotencyKey).toBe(`invoice:completed:${invoice.id}:completed`);
      const confirmedCall = booted.webhookDispatcher!.calls.find(
        (c) => (c.payload as { event: string }).event === "invoice:payment_confirmed"
      )!;
      expect(confirmedCall.idempotencyKey).toBe(`invoice:payment_confirmed:${invoice.id}:0xpromote`);
    } finally {
      await booted.close();
    }
  });
});
