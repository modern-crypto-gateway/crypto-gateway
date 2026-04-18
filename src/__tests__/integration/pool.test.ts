import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { addressPool, invoices } from "../../db/schema.js";
import {
  allocateForInvoice,
  getStats,
  initializePool,
  reconcileOrphanedAllocations,
  refillFamily,
  releaseFromInvoice
} from "../../core/domain/pool.service.js";
import { PoolExhaustedError } from "../../core/errors.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

// Pool is family-keyed, shared across merchants, and reused across invoices.
// These tests lock in the core behaviors: seeding, allocation CAS, release
// on terminal transitions, and exhaustion semantics.

describe("pool.service — initialize", () => {
  let booted: BootedTestApp;
  beforeEach(async () => {
    booted = await bootTestApp({ skipPoolInit: true });
  });
  afterEach(async () => {
    await booted.close();
  });

  it("seeds N addresses for each requested family", async () => {
    const results = await initializePool(booted.deps, {
      families: ["evm"],
      initialSize: 3
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ family: "evm", outcome: "topped-up", added: 3 });
    const stats = await getStats(booted.deps);
    expect(stats.find((s) => s.family === "evm")?.available).toBe(3);
  });

  it("is idempotent — re-running with the same initialSize adds nothing", async () => {
    await initializePool(booted.deps, { families: ["evm"], initialSize: 3 });
    const second = await initializePool(booted.deps, { families: ["evm"], initialSize: 3 });
    expect(second[0]).toMatchObject({ outcome: "already-sufficient", added: 0 });
  });

  it("tops up to target size when pool already has some rows", async () => {
    await initializePool(booted.deps, { families: ["evm"], initialSize: 2 });
    const topUp = await initializePool(booted.deps, { families: ["evm"], initialSize: 5 });
    expect(topUp[0]).toMatchObject({ outcome: "topped-up", priorCount: 2, added: 3 });
    const stats = await getStats(booted.deps);
    expect(stats.find((s) => s.family === "evm")?.available).toBe(5);
  });

  it("skips families with no wired chain adapter", async () => {
    // Test boot wires only the dev chain adapter (family=evm). Tron + Solana
    // are not available — initialize marks them skipped rather than failing.
    const results = await initializePool(booted.deps, {
      families: ["evm", "tron", "solana"],
      initialSize: 2
    });
    expect(results.find((r) => r.family === "tron")?.outcome).toBe("skipped-no-adapter");
    expect(results.find((r) => r.family === "solana")?.outcome).toBe("skipped-no-adapter");
    expect(results.find((r) => r.family === "evm")?.outcome).toBe("topped-up");
  });
});

describe("pool.service — allocate + release", () => {
  let booted: BootedTestApp;
  beforeEach(async () => {
    booted = await bootTestApp({ poolInitialSize: 3 });
  });
  afterEach(async () => {
    await booted.close();
  });

  it("allocates one pool row per call, flipping status to 'allocated'", async () => {
    const allocated = await allocateForInvoice(booted.deps, "invoice-1", "evm");
    expect(allocated.status).toBe("allocated");
    expect(allocated.allocatedToInvoiceId).toBe("invoice-1");
    expect(allocated.address).toBeTruthy();
  });

  it("returns to 'available' with bumped total_allocations on release", async () => {
    const allocated = await allocateForInvoice(booted.deps, "invoice-1", "evm");
    await releaseFromInvoice(booted.deps, "invoice-1");

    const [row] = await booted.deps.db
      .select({
        status: addressPool.status,
        allocated_to_invoice_id: addressPool.allocatedToInvoiceId,
        total_allocations: addressPool.totalAllocations
      })
      .from(addressPool)
      .where(eq(addressPool.id, allocated.id))
      .limit(1);
    expect(row?.status).toBe("available");
    expect(row?.allocated_to_invoice_id).toBeNull();
    expect(row?.total_allocations).toBe(1);
  });

  it("next allocation prefers the row with the LOWEST total_allocations (fair rotation)", async () => {
    // Allocate + release row A → total_allocations = 1.
    const a = await allocateForInvoice(booted.deps, "invoice-1", "evm");
    await releaseFromInvoice(booted.deps, "invoice-1");
    // Fresh allocation should prefer row B or C (total_allocations = 0), not A.
    const b = await allocateForInvoice(booted.deps, "invoice-2", "evm");
    expect(b.id).not.toBe(a.id);
    expect(b.totalAllocations).toBe(0);
  });

  it("throws PoolExhaustedError when the pool has no available rows", async () => {
    // Allocation triggers an async auto-refill when available dips below the
    // trigger threshold — but `promiseSetJobs` in Node-test mode runs deferred
    // work eagerly, so a 4th call would silently succeed after an inline
    // refill ran between allocations. Grab the refill lock manually to block
    // that, then exercise the exhaustion path cleanly.
    await booted.deps.cache.put("pool:refill-lock:evm", "1", { ttlSeconds: 60 });
    try {
      await allocateForInvoice(booted.deps, "invoice-1", "evm");
      await allocateForInvoice(booted.deps, "invoice-2", "evm");
      await allocateForInvoice(booted.deps, "invoice-3", "evm");
      await expect(allocateForInvoice(booted.deps, "invoice-4", "evm")).rejects.toBeInstanceOf(
        PoolExhaustedError
      );
    } finally {
      await booted.deps.cache.delete("pool:refill-lock:evm");
    }
  });

  it("releases all rows tied to one invoiceId (multi-family ready)", async () => {
    // Simulate future multi-family allocation: two rows tied to same invoice.
    const a = await allocateForInvoice(booted.deps, "multi-invoice", "evm");
    // Manually claim a second row to simulate a separate family allocation
    // (not actually a separate family here since test only has evm, but the
    // release-by-invoiceId behavior is family-agnostic). SQLite doesn't
    // support UPDATE...LIMIT — subquery picks the next available id.
    const candidateIds = booted.deps.db
      .select({ id: addressPool.id })
      .from(addressPool)
      .where(and(eq(addressPool.family, "evm"), eq(addressPool.status, "available")))
      .limit(1);
    await booted.deps.db
      .update(addressPool)
      .set({ status: "allocated", allocatedToInvoiceId: "multi-invoice", allocatedAt: Date.now() })
      .where(sql`${addressPool.id} = (${candidateIds})`);

    await releaseFromInvoice(booted.deps, "multi-invoice");
    const [rows] = await booted.deps.db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(addressPool)
      .where(eq(addressPool.allocatedToInvoiceId, "multi-invoice"));
    expect(Number(rows?.cnt)).toBe(0);
    // The explicitly-allocated row `a` is also released.
    const [aRow] = await booted.deps.db
      .select({ status: addressPool.status })
      .from(addressPool)
      .where(eq(addressPool.id, a.id))
      .limit(1);
    expect(aRow?.status).toBe("available");
  });
});

describe("pool.service — refill", () => {
  let booted: BootedTestApp;
  beforeEach(async () => {
    booted = await bootTestApp({ skipPoolInit: true });
  });
  afterEach(async () => {
    await booted.close();
  });

  it("inserts N new rows with monotonically increasing address_index", async () => {
    await refillFamily(booted.deps, "evm", 3);
    const rows = await booted.deps.db
      .select({ address_index: addressPool.addressIndex })
      .from(addressPool)
      .where(eq(addressPool.family, "evm"))
      .orderBy(asc(addressPool.addressIndex));
    expect(rows.map((r) => r.address_index)).toEqual([0, 1, 2]);
  });

  it("continues indexing from MAX on subsequent refills (no gaps, no duplicates)", async () => {
    await refillFamily(booted.deps, "evm", 2);
    await refillFamily(booted.deps, "evm", 3);
    const rows = await booted.deps.db
      .select({ address_index: addressPool.addressIndex })
      .from(addressPool)
      .where(eq(addressPool.family, "evm"))
      .orderBy(asc(addressPool.addressIndex));
    expect(rows.map((r) => r.address_index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("no-ops while the per-family refill mutex is held", async () => {
    // Grab the lock manually. A concurrent refillFamily call should find it
    // held and return 0 without deriving any addresses.
    await booted.deps.cache.put("pool:refill-lock:evm", "1", { ttlSeconds: 60 });
    const added = await refillFamily(booted.deps, "evm", 3);
    expect(added).toBe(0);
    const [rows] = await booted.deps.db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(addressPool)
      .where(eq(addressPool.family, "evm"));
    expect(Number(rows?.cnt)).toBe(0);
  });
});

describe("pool.service — reconcileOrphanedAllocations", () => {
  let booted: BootedTestApp;
  beforeEach(async () => {
    booted = await bootTestApp({ poolInitialSize: 6 });
  });
  afterEach(async () => {
    await booted.close();
  });

  // Helper: insert a minimal invoice row with the given status. Avoids going
  // through createInvoice (which would itself touch the pool). All required
  // columns are filled with placeholder values that satisfy NOT NULL/CHECK
  // constraints — only `id` and `status` matter for the reconciler.
  async function insertInvoiceRow(id: string, status: "created" | "expired"): Promise<void> {
    const t = Date.now();
    await booted.deps.db.insert(invoices).values({
      id,
      merchantId: "00000000-0000-0000-0000-000000000001",
      status,
      chainId: 999,
      token: "DEV",
      receiveAddress: "placeholder",
      addressIndex: 0,
      requiredAmountRaw: "0",
      receivedAmountRaw: "0",
      acceptedFamilies: JSON.stringify(["evm"]),
      paidUsd: "0",
      overpaidUsd: "0",
      paymentToleranceUnderBps: 0,
      paymentToleranceOverBps: 0,
      createdAt: t,
      expiresAt: t + 60_000,
      updatedAt: t
    });
  }

  // Helper: backdate the allocated_at on a pool row past the grace window so
  // the reconciler treats it as old enough to release. Default grace is 60s.
  async function ageAllocation(poolRowId: string): Promise<void> {
    await booted.deps.db
      .update(addressPool)
      .set({ allocatedAt: Date.now() - 5 * 60 * 1000 })
      .where(eq(addressPool.id, poolRowId));
  }

  it("releases rows whose invoice_id has no matching invoice row (failed insert)", async () => {
    // Allocate but never insert an invoice → orphan. Backdate so it's past grace.
    const orphaned = await allocateForInvoice(booted.deps, "ghost-invoice", "evm");
    await ageAllocation(orphaned.id);

    const result = await reconcileOrphanedAllocations(booted.deps);
    expect(result.released).toBe(1);

    const [row] = await booted.deps.db
      .select({ status: addressPool.status, invoiceId: addressPool.allocatedToInvoiceId })
      .from(addressPool)
      .where(eq(addressPool.id, orphaned.id))
      .limit(1);
    expect(row?.status).toBe("available");
    expect(row?.invoiceId).toBeNull();
  });

  it("releases rows whose invoice is in a terminal state (event-bus release missed)", async () => {
    const a = await allocateForInvoice(booted.deps, "terminal-invoice", "evm");
    await insertInvoiceRow("terminal-invoice", "expired");
    await ageAllocation(a.id);

    const result = await reconcileOrphanedAllocations(booted.deps);
    expect(result.released).toBe(1);

    const [row] = await booted.deps.db
      .select({ status: addressPool.status })
      .from(addressPool)
      .where(eq(addressPool.id, a.id))
      .limit(1);
    expect(row?.status).toBe("available");
  });

  it("does NOT release rows tied to an active (non-terminal) invoice", async () => {
    const a = await allocateForInvoice(booted.deps, "active-invoice", "evm");
    await insertInvoiceRow("active-invoice", "created");
    await ageAllocation(a.id);

    const result = await reconcileOrphanedAllocations(booted.deps);
    expect(result.released).toBe(0);

    const [row] = await booted.deps.db
      .select({ status: addressPool.status })
      .from(addressPool)
      .where(eq(addressPool.id, a.id))
      .limit(1);
    expect(row?.status).toBe("allocated");
  });

  it("respects the grace window — recently-allocated orphans are left alone", async () => {
    // Orphan, but allocated_at is fresh (default `Date.now()`). Reconciler
    // must skip it so an in-flight create-invoice flow isn't raced.
    await allocateForInvoice(booted.deps, "in-flight-invoice", "evm");

    const result = await reconcileOrphanedAllocations(booted.deps);
    expect(result.released).toBe(0);
  });

  it("releases when allocated_to_invoice_id is NULL but status is 'allocated' (broken state)", async () => {
    // Reach into the table to create the broken state directly — no API path
    // produces this, but historical data sometimes has it.
    const [available] = await booted.deps.db
      .select({ id: addressPool.id })
      .from(addressPool)
      .where(and(eq(addressPool.family, "evm"), eq(addressPool.status, "available")))
      .limit(1);
    if (!available) throw new Error("test setup: no available row");
    await booted.deps.db
      .update(addressPool)
      .set({
        status: "allocated",
        allocatedToInvoiceId: null,
        allocatedAt: Date.now() - 5 * 60 * 1000
      })
      .where(eq(addressPool.id, available.id));

    const result = await reconcileOrphanedAllocations(booted.deps);
    expect(result.released).toBe(1);
  });
});
