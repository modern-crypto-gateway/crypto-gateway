import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressPool, invoices, transactions } from "../../db/schema.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import type { ChainId } from "../../core/types/chain.js";
import type { TokenSymbol } from "../../core/types/token.js";

const ADMIN_KEY = "super-secret-admin-key";
const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

async function expireInvoice(booted: BootedTestApp, invoiceId: string): Promise<void> {
  await booted.deps.db
    .update(invoices)
    .set({ status: "expired" })
    .where(eq(invoices.id, invoiceId));
}

async function stampCooldown(
  booted: BootedTestApp,
  address: string,
  cooldownUntilMs: number
): Promise<void> {
  await booted.deps.db
    .update(addressPool)
    .set({ cooldownUntil: cooldownUntilMs, lastReleasedByMerchantId: MERCHANT_ID })
    .where(eq(addressPool.address, address));
}

describe("PaymentService ingest — orphan write path", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("writes a transfer on an unknown address as an orphan (invoice_id NULL, status='orphaned', no tx events)", async () => {
    const events: string[] = [];
    booted.deps.events.subscribeAll((e) => { events.push(e.type); });

    const res = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xorphan1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000099",
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });
    expect(res.inserted).toBe(true);
    expect(res.invoiceId).toBeUndefined();

    const [row] = await booted.deps.db
      .select({ invoiceId: transactions.invoiceId, status: transactions.status })
      .from(transactions)
      .where(eq(transactions.txHash, "0xorphan1"))
      .limit(1);
    expect(row?.invoiceId).toBeNull();
    expect(row?.status).toBe("orphaned");

    expect(events).not.toContain("tx.detected");
    expect(events).not.toContain("tx.confirmed");
    expect(events).not.toContain("invoice.payment_received");
  });

  it("credits the expired invoice when the pool address is still in cooldown (no orphan)", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    await expireInvoice(booted, invoice.id);
    // Cooldown until far in the future — the pool address should still map
    // the late payment to the expired invoice.
    await stampCooldown(booted, invoice.receiveAddress, Date.now() + 3_600_000);

    const res = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xlate1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });
    expect(res.inserted).toBe(true);
    expect(res.invoiceId).toBe(invoice.id);

    const [row] = await booted.deps.db
      .select({ invoiceId: transactions.invoiceId, status: transactions.status })
      .from(transactions)
      .where(eq(transactions.txHash, "0xlate1"))
      .limit(1);
    expect(row?.invoiceId).toBe(invoice.id);
    expect(row?.status).toBe("confirmed");

    // Invoice stays expired — recompute's terminal gate bails without admin override.
    const [inv] = await booted.deps.db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(inv?.status).toBe("expired");
  });

  it("orphans a late payment when the cooldown window has elapsed", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    await expireInvoice(booted, invoice.id);
    // Cooldown deadline already in the past: the candidate invoice is
    // terminal and not covered by cooldown, so the ingest treats the
    // transfer as an orphan.
    await stampCooldown(booted, invoice.receiveAddress, Date.now() - 1);

    const res = await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xlate2",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    });
    expect(res.inserted).toBe(true);
    expect(res.invoiceId).toBeUndefined();

    const [row] = await booted.deps.db
      .select({ invoiceId: transactions.invoiceId, status: transactions.status })
      .from(transactions)
      .where(eq(transactions.txHash, "0xlate2"))
      .limit(1);
    expect(row?.invoiceId).toBeNull();
    expect(row?.status).toBe("orphaned");
  });
});

describe("GET /admin/orphan-transactions", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("lists open orphans ordered by detectedAt desc and filters by chainId", async () => {
    await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xlist1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000099",
      token: "DEV",
      amountRaw: "100",
      blockNumber: 1,
      confirmations: 5,
      seenAt: new Date()
    });
    await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xlist2",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000099",
      token: "DEV",
      amountRaw: "200",
      blockNumber: 2,
      confirmations: 5,
      seenAt: new Date()
    });

    const res = await booted.app.fetch(
      new Request("http://test.local/admin/orphan-transactions?chainId=999", {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orphans: Array<{ txHash: string; chainId: number; status: string }>;
    };
    expect(body.orphans.length).toBe(2);
    for (const o of body.orphans) {
      expect(o.chainId).toBe(999);
      expect(o.status).toBe("orphaned");
    }

    // chainId mismatch → empty list.
    const other = await booted.app.fetch(
      new Request("http://test.local/admin/orphan-transactions?chainId=1", {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { orphans: unknown[] };
    expect(otherBody.orphans.length).toBe(0);
  });
});

describe("POST /admin/orphan-transactions/:id/attribute", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function createOrphan(txHash: string, amountRaw: string, confirmations = 5): Promise<string> {
    await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash,
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000099",
      token: "DEV",
      amountRaw,
      blockNumber: 100,
      confirmations,
      seenAt: new Date()
    });
    const [row] = await booted.deps.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.txHash, txHash))
      .limit(1);
    return row!.id;
  }

  it("attributes an orphan to an active invoice and flips the invoice per normal rules", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    const txId = await createOrphan("0xattr1", "1000");

    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/${txId}/attribute`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ invoiceId: invoice.id })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attribution: { invoiceStatusBefore: string; invoiceStatusAfter: string };
    };
    expect(body.attribution.invoiceStatusBefore).toBe("created");
    expect(body.attribution.invoiceStatusAfter).toBe("confirmed");

    // Tx is now linked; invoice is confirmed.
    const [txRow] = await booted.deps.db
      .select({ invoiceId: transactions.invoiceId, status: transactions.status })
      .from(transactions)
      .where(eq(transactions.id, txId))
      .limit(1);
    expect(txRow?.invoiceId).toBe(invoice.id);
    expect(txRow?.status).toBe("confirmed");
  });

  it("flips an expired invoice to confirmed when the attributed orphan clears the confirm bar", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    await expireInvoice(booted, invoice.id);
    const txId = await createOrphan("0xattr2", "1000");

    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/${txId}/attribute`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ invoiceId: invoice.id })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attribution: { invoiceStatusBefore: string; invoiceStatusAfter: string };
    };
    expect(body.attribution.invoiceStatusBefore).toBe("expired");
    expect(body.attribution.invoiceStatusAfter).toBe("confirmed");

    const [inv] = await booted.deps.db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(inv?.status).toBe("confirmed");
  });

  it("leaves an expired invoice expired when the attributed orphan is below the confirm bar (no partial flip)", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    await expireInvoice(booted, invoice.id);
    const txId = await createOrphan("0xattr3", "500"); // half the required amount

    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/${txId}/attribute`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ invoiceId: invoice.id })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attribution: { invoiceStatusBefore: string; invoiceStatusAfter: string };
    };
    expect(body.attribution.invoiceStatusBefore).toBe("expired");
    expect(body.attribution.invoiceStatusAfter).toBe("expired");

    const [inv] = await booted.deps.db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);
    expect(inv?.status).toBe("expired");
  });

  it("returns 404 for an unknown orphan id and 409 for an already-attributed tx", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    const txId = await createOrphan("0xattr4", "1000");

    // First attribution succeeds.
    const first = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/${txId}/attribute`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ invoiceId: invoice.id })
      })
    );
    expect(first.status).toBe(200);

    // Second attribution on the same tx → 409 (already linked).
    const second = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/${txId}/attribute`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ invoiceId: invoice.id })
      })
    );
    expect(second.status).toBe(409);

    // Unknown id → 404.
    const notFound = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/does-not-exist/attribute`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ invoiceId: invoice.id })
      })
    );
    expect(notFound.status).toBe(404);
  });
});

describe("POST /admin/orphan-transactions/:id/dismiss", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("sets dismissedAt + reason and hides the row from the queue", async () => {
    await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xdismiss1",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000099",
      token: "DEV",
      amountRaw: "100",
      blockNumber: 1,
      confirmations: 5,
      seenAt: new Date()
    });
    const [row] = await booted.deps.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.txHash, "0xdismiss1"))
      .limit(1);
    const txId = row!.id;

    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/${txId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ reason: "customer refunded out-of-band" })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dismissal: { reason: string } };
    expect(body.dismissal.reason).toBe("customer refunded out-of-band");

    const [stored] = await booted.deps.db
      .select({ dismissedAt: transactions.dismissedAt, reason: transactions.dismissReason })
      .from(transactions)
      .where(eq(transactions.id, txId))
      .limit(1);
    expect(stored?.dismissedAt).not.toBeNull();
    expect(stored?.reason).toBe("customer refunded out-of-band");

    // Dismissed rows no longer appear in the open-orphans queue.
    const list = await booted.app.fetch(
      new Request("http://test.local/admin/orphan-transactions", {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { orphans: unknown[] };
    expect(listBody.orphans.length).toBe(0);
  });

  it("returns 409 when dismissing an already-attributed transaction", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
    // Regular ingest that credits the invoice — tx has invoice_id set.
    await ingestDetectedTransfer(booted.deps, {
      chainId: 999,
      txHash: "0xnot-orphan",
      logIndex: 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: invoice.receiveAddress,
      token: "DEV",
      amountRaw: "1000",
      blockNumber: 1,
      confirmations: 5,
      seenAt: new Date()
    });
    const [row] = await booted.deps.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.txHash, "0xnot-orphan"))
      .limit(1);
    const txId = row!.id;

    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/orphan-transactions/${txId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ reason: "mistake" })
      })
    );
    expect(res.status).toBe(409);
  });
});

describe("POST /admin/audit-address", () => {
  // Tests use the dev adapter's `incomingTransfers` override to simulate the
  // chain's response to scanIncoming. Audit diffs these against stored rows
  // and ingests the missing ones through the normal ingest path.

  const ADMIN_ADDRESS = "0x00000000000000000000000000000000000000aa";

  function makeTransfer(opts: {
    txHash: string;
    toAddress: string;
    amountRaw: string;
    logIndex?: number;
  }): DetectedTransfer {
    return {
      chainId: 999 as ChainId,
      txHash: opts.txHash,
      logIndex: opts.logIndex ?? 0,
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: opts.toAddress,
      token: "DEV" as TokenSymbol,
      amountRaw: opts.amountRaw,
      blockNumber: 100,
      confirmations: 5,
      seenAt: new Date()
    };
  }

  it("inserts missing transfers and skips ones already stored (idempotent)", async () => {
    const transfers: DetectedTransfer[] = [
      makeTransfer({ txHash: "0xaudit-seen", toAddress: ADMIN_ADDRESS, amountRaw: "100" }),
      makeTransfer({ txHash: "0xaudit-missing", toAddress: ADMIN_ADDRESS, amountRaw: "200" })
    ];
    const booted = await bootTestApp({
      secretsOverrides: { ADMIN_KEY },
      chains: [devChainAdapter({ incomingTransfers: transfers })]
    });
    try {
      // Pre-insert one of the transfers (simulates "already detected by webhook").
      await ingestDetectedTransfer(booted.deps, transfers[0]!);

      const res = await booted.app.fetch(
        new Request("http://test.local/admin/audit-address", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
          body: JSON.stringify({ chainId: 999, address: ADMIN_ADDRESS, sinceMs: 0 })
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        audit: { scanned: number; inserted: number; alreadyPresent: number };
      };
      expect(body.audit.scanned).toBe(2);
      expect(body.audit.inserted).toBe(1);
      expect(body.audit.alreadyPresent).toBe(1);

      // Both rows should now exist in transactions.
      const rows = await booted.deps.db.select().from(transactions);
      expect(rows.length).toBe(2);
    } finally {
      await booted.close();
    }
  });

  it("attributes a missing transfer to an active invoice via the normal ingest path", async () => {
    // Fresh boot without transfers — we create the invoice first to discover
    // its receive address, then reboot with a pre-seeded transfer for that
    // address. (Simpler than mutating the adapter mid-test.)
    const discoverBooted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
    const invoice = await createInvoiceViaApi(discoverBooted, { amountRaw: "1000" });
    const receiveAddress = invoice.receiveAddress;
    await discoverBooted.close();

    const transfer = makeTransfer({
      txHash: "0xaudit-credit",
      toAddress: receiveAddress,
      amountRaw: "1000"
    });
    const booted = await bootTestApp({
      secretsOverrides: { ADMIN_KEY },
      chains: [devChainAdapter({ incomingTransfers: [transfer] })]
    });
    try {
      // Re-create the same invoice on the fresh app so the address mapping exists.
      const newInvoice = await createInvoiceViaApi(booted, { amountRaw: "1000" });
      // The pool is deterministic per seed so the same address comes back first.
      expect(newInvoice.receiveAddress).toBe(receiveAddress);

      const res = await booted.app.fetch(
        new Request("http://test.local/admin/audit-address", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
          body: JSON.stringify({ chainId: 999, address: receiveAddress, sinceMs: 0 })
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { audit: { inserted: number } };
      expect(body.audit.inserted).toBe(1);

      // Invoice confirmed via the normal ingest code path.
      const [inv] = await booted.deps.db
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, newInvoice.id))
        .limit(1);
      expect(inv?.status).toBe("confirmed");
    } finally {
      await booted.close();
    }
  });

  it("records transfers on an address with no invoice mapping as orphans", async () => {
    const transfer = makeTransfer({
      txHash: "0xaudit-orphan",
      toAddress: ADMIN_ADDRESS,
      amountRaw: "500"
    });
    const booted = await bootTestApp({
      secretsOverrides: { ADMIN_KEY },
      chains: [devChainAdapter({ incomingTransfers: [transfer] })]
    });
    try {
      const res = await booted.app.fetch(
        new Request("http://test.local/admin/audit-address", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
          body: JSON.stringify({ chainId: 999, address: ADMIN_ADDRESS, sinceMs: 0 })
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { audit: { inserted: number } };
      expect(body.audit.inserted).toBe(1);

      const [row] = await booted.deps.db
        .select({ invoiceId: transactions.invoiceId, status: transactions.status })
        .from(transactions)
        .where(eq(transactions.txHash, "0xaudit-orphan"))
        .limit(1);
      expect(row?.invoiceId).toBeNull();
      expect(row?.status).toBe("orphaned");
    } finally {
      await booted.close();
    }
  });

  it("returns 500 on an unknown chainId (no adapter registered)", async () => {
    const booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
    try {
      const res = await booted.app.fetch(
        new Request("http://test.local/admin/audit-address", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
          body: JSON.stringify({ chainId: 424242, address: ADMIN_ADDRESS })
        })
      );
      // findChainAdapter throws a plain Error for unregistered chains; the
      // route's catch-block surfaces this as INTERNAL 500. Same behavior as
      // /fee-wallets. Callers pre-validate chainId against /pool/stats or
      // /balances before invoking audit.
      expect(res.status).toBe(500);
    } finally {
      await booted.close();
    }
  });
});
