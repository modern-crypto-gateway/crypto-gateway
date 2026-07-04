import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, createInvoiceViaApi } from "../helpers/boot.js";
import { sweepExpiredInvoices } from "../../core/domain/invoice.service.js";
import { PROCESSING_EXPIRY_GRACE_MS } from "../../core/domain/payment-config.js";
import { invoices } from "../../db/schema.js";

// The expiry-vs-confirmation race: an invoice paid within its window but
// still accumulating confirmations ('processing') must NOT be expired at
// expiresAt — BTC's 6-conf threshold (~60 min) is structurally longer than
// the 30-min default expiry, so expiring 'processing' rows guaranteed that
// every normally-paid BTC invoice froze (expired invoices are skipped by
// recomputeInvoiceFromTransactions) and never reached 'completed'.
// 'processing' gets PROCESSING_EXPIRY_GRACE_MS; 'pending' (never paid)
// expires on time, unchanged.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

describe("sweepExpiredInvoices — processing grace window", () => {
  it("expires 'pending' at expiresAt but holds 'processing' through the grace window", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const booted = await bootTestApp({
      clock: { now: () => new Date(nowMs) },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      // Two invoices on the dev chain (default 30-min expiry).
      const pendingInvoice = await createInvoiceViaApi(booted, { amountRaw: "1000000" });
      const processingInvoice = await createInvoiceViaApi(booted, { amountRaw: "1000000" });
      // Simulate "payment detected, awaiting confirmations" on the second.
      await booted.deps.db
        .update(invoices)
        .set({ status: "processing" })
        .where(eq(invoices.id, processingInvoice.id));

      // Just past expiresAt (30 min + 1 s): pending expires, processing survives.
      nowMs += 30 * 60 * 1000 + 1000;
      const first = await sweepExpiredInvoices(booted.deps);
      expect(first.expired).toBe(1);
      const [stillProcessing] = await booted.deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, processingInvoice.id));
      expect(stillProcessing!.status).toBe("processing");
      const [expiredPending] = await booted.deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, pendingInvoice.id));
      expect(expiredPending!.status).toBe("expired");

      // Still inside the grace window (12h later): untouched.
      nowMs += 12 * 60 * 60 * 1000;
      const second = await sweepExpiredInvoices(booted.deps);
      expect(second.expired).toBe(0);

      // Past expiresAt + grace: the stuck partial finally closes.
      nowMs += PROCESSING_EXPIRY_GRACE_MS;
      const third = await sweepExpiredInvoices(booted.deps);
      expect(third.expired).toBe(1);
      const [finallyExpired] = await booted.deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, processingInvoice.id));
      expect(finallyExpired!.status).toBe("expired");
    } finally {
      await booted.close();
    }
  });
});
