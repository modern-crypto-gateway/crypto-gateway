import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allocateForOrder,
  getStats,
  initializePool,
  refillFamily,
  releaseFromOrder
} from "../../core/domain/pool.service.js";
import { PoolExhaustedError } from "../../core/errors.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

// Pool is family-keyed, shared across merchants, and reused across orders.
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
    const allocated = await allocateForOrder(booted.deps, "order-1", "evm");
    expect(allocated.status).toBe("allocated");
    expect(allocated.allocatedToOrderId).toBe("order-1");
    expect(allocated.address).toBeTruthy();
  });

  it("returns to 'available' with bumped total_allocations on release", async () => {
    const allocated = await allocateForOrder(booted.deps, "order-1", "evm");
    await releaseFromOrder(booted.deps, "order-1");

    const row = await booted.deps.db
      .prepare("SELECT status, allocated_to_order_id, total_allocations FROM address_pool WHERE id = ?")
      .bind(allocated.id)
      .first<{ status: string; allocated_to_order_id: string | null; total_allocations: number }>();
    expect(row?.status).toBe("available");
    expect(row?.allocated_to_order_id).toBeNull();
    expect(row?.total_allocations).toBe(1);
  });

  it("next allocation prefers the row with the LOWEST total_allocations (fair rotation)", async () => {
    // Allocate + release row A → total_allocations = 1.
    const a = await allocateForOrder(booted.deps, "order-1", "evm");
    await releaseFromOrder(booted.deps, "order-1");
    // Fresh allocation should prefer row B or C (total_allocations = 0), not A.
    const b = await allocateForOrder(booted.deps, "order-2", "evm");
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
      await allocateForOrder(booted.deps, "order-1", "evm");
      await allocateForOrder(booted.deps, "order-2", "evm");
      await allocateForOrder(booted.deps, "order-3", "evm");
      await expect(allocateForOrder(booted.deps, "order-4", "evm")).rejects.toBeInstanceOf(
        PoolExhaustedError
      );
    } finally {
      await booted.deps.cache.delete("pool:refill-lock:evm");
    }
  });

  it("releases all rows tied to one orderId (multi-family ready)", async () => {
    // Simulate future multi-family allocation: two rows tied to same order.
    const a = await allocateForOrder(booted.deps, "multi-order", "evm");
    // Manually claim a second row to simulate a separate family allocation
    // (not actually a separate family here since test only has evm, but the
    // release-by-orderId behavior is family-agnostic). SQLite doesn't
    // support UPDATE...LIMIT — subquery picks the next available id.
    await booted.deps.db
      .prepare(
        `UPDATE address_pool SET status = 'allocated', allocated_to_order_id = ?, allocated_at = ?
         WHERE id = (SELECT id FROM address_pool WHERE family = 'evm' AND status = 'available' LIMIT 1)`
      )
      .bind("multi-order", Date.now())
      .run();

    await releaseFromOrder(booted.deps, "multi-order");
    const rows = await booted.deps.db
      .prepare("SELECT COUNT(*) AS cnt FROM address_pool WHERE allocated_to_order_id = ?")
      .bind("multi-order")
      .first<{ cnt: number }>();
    expect(rows?.cnt).toBe(0);
    // The explicitly-allocated row `a` is also released.
    const aRow = await booted.deps.db
      .prepare("SELECT status FROM address_pool WHERE id = ?")
      .bind(a.id)
      .first<{ status: string }>();
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
      .prepare("SELECT address_index FROM address_pool WHERE family = 'evm' ORDER BY address_index ASC")
      .all<{ address_index: number }>();
    expect(rows.results.map((r) => r.address_index)).toEqual([0, 1, 2]);
  });

  it("continues indexing from MAX on subsequent refills (no gaps, no duplicates)", async () => {
    await refillFamily(booted.deps, "evm", 2);
    await refillFamily(booted.deps, "evm", 3);
    const rows = await booted.deps.db
      .prepare("SELECT address_index FROM address_pool WHERE family = 'evm' ORDER BY address_index ASC")
      .all<{ address_index: number }>();
    expect(rows.results.map((r) => r.address_index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("no-ops while the per-family refill mutex is held", async () => {
    // Grab the lock manually. A concurrent refillFamily call should find it
    // held and return 0 without deriving any addresses.
    await booted.deps.cache.put("pool:refill-lock:evm", "1", { ttlSeconds: 60 });
    const added = await refillFamily(booted.deps, "evm", 3);
    expect(added).toBe(0);
    const rows = await booted.deps.db
      .prepare("SELECT COUNT(*) AS cnt FROM address_pool WHERE family = 'evm'")
      .first<{ cnt: number }>();
    expect(rows?.cnt).toBe(0);
  });
});
