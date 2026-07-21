import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressPool, transactions } from "../../db/schema.js";
import type { AppDeps } from "../../core/app-deps.js";
import type { DomainEvent } from "../../core/events/event-bus.port.js";
import {
  allocateForInvoice,
  disablePoolAddress,
  enablePoolAddress,
  getStats,
  refillFamily,
  rescanRetiredAddresses,
  shrinkIdlePools
} from "../../core/domain/pool.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

// Auto-shrink lifecycle: a demand spike grows the pool; once the surplus rows
// sit idle past the retire window with zero ledger balance, shrinkIdlePools
// parks them ('quarantined' + retired_at) and publishes
// pool.address.quarantined so the Alchemy tracker deregisters the watchers.
// Every return-to-service path (refill reactivation, exhaustion borrow,
// operator enable, stray-funds rescan) clears retired_at and re-publishes
// pool.address.created.

const HOUR_MS = 60 * 60 * 1000;

describe("pool.service — auto-shrink + reactivation", () => {
  let booted: BootedTestApp;
  let nowMs: number;
  let deps: AppDeps;
  let quarantinedEvents: Array<{ address: string }>;
  let createdEvents: Array<{ address: string }>;
  let unsubscribers: Array<() => void>;

  beforeEach(async () => {
    nowMs = Date.UTC(2026, 0, 1);
    booted = await bootTestApp({
      poolInitialSize: 8,
      clock: { now: () => new Date(nowMs) }
    });
    deps = { ...booted.deps, poolRetireIdleHours: 24, poolMinAvailable: 2 };
    quarantinedEvents = [];
    createdEvents = [];
    unsubscribers = [
      deps.events.subscribe("pool.address.quarantined", (e: DomainEvent) => {
        if (e.type === "pool.address.quarantined") quarantinedEvents.push({ address: e.address });
      }),
      deps.events.subscribe("pool.address.created", (e: DomainEvent) => {
        if (e.type === "pool.address.created") createdEvents.push({ address: e.address });
      })
    ];
  });

  afterEach(async () => {
    for (const u of unsubscribers) u();
    await booted.close();
  });

  async function poolRows() {
    return deps.db.select().from(addressPool).where(eq(addressPool.family, "evm"));
  }

  it("retires idle zero-balance rows beyond the floor and deregisters watchers", async () => {
    nowMs += 25 * HOUR_MS; // past the 24h idle window

    const result = await shrinkIdlePools(deps, { force: true });

    expect(result.ran).toBe(true);
    expect(result.retired).toBe(6); // 8 available - floor of 2
    expect(result.skippedWithBalance).toBe(0);
    expect(quarantinedEvents).toHaveLength(6);

    const rows = await poolRows();
    const retired = rows.filter((r) => r.retiredAt !== null);
    expect(retired).toHaveLength(6);
    for (const row of retired) {
      expect(row.status).toBe("quarantined");
      expect(row.disabledAt).toBeNull();
    }
    expect(rows.filter((r) => r.status === "available")).toHaveLength(2);

    const stats = await getStats(deps);
    expect(stats.find((s) => s.family === "evm")?.retired).toBe(6);
  });

  it("does not retire rows inside the idle window", async () => {
    nowMs += 1 * HOUR_MS; // young pool

    const result = await shrinkIdlePools(deps, { force: true });

    expect(result.retired).toBe(0);
    expect(quarantinedEvents).toHaveLength(0);
    const rows = await poolRows();
    expect(rows.filter((r) => r.status === "available")).toHaveLength(8);
  });

  it("skips a candidate whose ledger shows a balance", async () => {
    const rows = await poolRows();
    const funded = rows[0]!;
    await deps.db.insert(transactions).values({
      id: "tx-funded-1",
      chainId: 999,
      txHash: "hash-funded-1",
      fromAddress: "0xsender",
      toAddress: funded.address,
      token: "DEV",
      amountRaw: "1000",
      status: "confirmed",
      detectedAt: nowMs
    });
    nowMs += 25 * HOUR_MS;

    const result = await shrinkIdlePools(deps, { force: true });

    expect(result.skippedWithBalance).toBe(1);
    const [fundedAfter] = await deps.db
      .select()
      .from(addressPool)
      .where(eq(addressPool.id, funded.id));
    expect(fundedAfter?.status).toBe("available");
    expect(fundedAfter?.retiredAt).toBeNull();
  });

  it("skips a candidate holding an unconfirmed (orphaned) credit the ledger can't spend yet", async () => {
    const rows = await poolRows();
    const orphanFunded = rows[1]!;
    await deps.db.insert(transactions).values({
      id: "tx-orphan-1",
      chainId: 999,
      txHash: "hash-orphan-1",
      fromAddress: "0xpayer",
      toAddress: orphanFunded.address,
      token: "DEV",
      amountRaw: "500",
      status: "orphaned",
      detectedAt: nowMs
    });
    nowMs += 25 * HOUR_MS;

    const result = await shrinkIdlePools(deps, { force: true });

    expect(result.skippedWithBalance).toBe(1);
    const [after] = await deps.db
      .select()
      .from(addressPool)
      .where(eq(addressPool.id, orphanFunded.id));
    expect(after?.status).toBe("available");
    expect(after?.retiredAt).toBeNull();
  });

  it("reactivated rows get a fresh idle grace and survive the next shrink run", async () => {
    nowMs += 25 * HOUR_MS;
    await shrinkIdlePools(deps, { force: true }); // 2 available, 6 retired
    const brought = await refillFamily(deps, "evm", 3); // reactivates 3
    expect(brought).toBe(3);
    const reactivatedIds = new Set(
      (await poolRows()).filter((r) => r.status === "available" && r.lastReleasedAt !== null).map((r) => r.id)
    );
    expect(reactivatedIds.size).toBe(3);

    // Same hour, another (forced) shrink: the 2 original floor rows are
    // still ancient-idle and retire, but every reactivated row keeps its
    // fresh grace — no retire/reactivate ping-pong.
    await shrinkIdlePools(deps, { force: true });
    const after = await poolRows();
    for (const r of after) {
      if (reactivatedIds.has(r.id)) {
        expect(r.status).toBe("available");
        expect(r.retiredAt).toBeNull();
      }
    }
  });

  it("rescan does not flag a stray (and keeps the row retired) when a detected credit explains the balance", async () => {
    const withFloor: AppDeps = { ...deps, poolMinAvailable: 7 }; // retire exactly 1
    nowMs += 25 * HOUR_MS;
    const shrunk = await shrinkIdlePools(withFloor, { force: true });
    expect(shrunk.retired).toBe(1);
    const retired = (await poolRows()).find((r) => r.retiredAt !== null)!;
    await deps.db.insert(transactions).values({
      id: "tx-detected-1",
      chainId: 999,
      txHash: "hash-detected-1",
      fromAddress: "0xpayer",
      toAddress: retired.address,
      token: "DEV",
      amountRaw: "5000",
      status: "detected",
      detectedAt: nowMs
    });
    const dev = deps.chains.find((c) => c.family === "evm")!;
    const strayDeps: AppDeps = {
      ...deps,
      chains: [
        {
          ...dev,
          getAccountBalances: async () =>
            [{ token: "DEV", amountRaw: "5000" }] as Awaited<
              ReturnType<typeof dev.getAccountBalances>
            >
        }
      ]
    };

    const result = await rescanRetiredAddresses(strayDeps, { force: true });

    expect(result.straysFound).toBe(0);
    const [after] = await deps.db.select().from(addressPool).where(eq(addressPool.id, retired.id));
    expect(after?.retiredAt).not.toBeNull(); // stays retired — nothing stray
  });

  it("honors the disable knob (poolRetireIdleHours = 0)", async () => {
    nowMs += 48 * HOUR_MS;
    const off: AppDeps = { ...deps, poolRetireIdleHours: 0 };
    const result = await shrinkIdlePools(off, { force: true });
    expect(result.ran).toBe(false);
    expect((await poolRows()).filter((r) => r.status === "available")).toHaveLength(8);
  });

  it("refill reactivates retired rows before minting new indices", async () => {
    nowMs += 25 * HOUR_MS;
    await shrinkIdlePools(deps, { force: true });
    const maxIndexBefore = Math.max(...(await poolRows()).map((r) => r.addressIndex));
    createdEvents = [];

    const brought = await refillFamily(deps, "evm", 3);

    expect(brought).toBe(3);
    expect(createdEvents).toHaveLength(3);
    const rows = await poolRows();
    // No new HD index minted — demand was met from retired stock.
    expect(Math.max(...rows.map((r) => r.addressIndex))).toBe(maxIndexBefore);
    expect(rows.filter((r) => r.status === "available")).toHaveLength(5);
    expect(rows.filter((r) => r.retiredAt !== null)).toHaveLength(3);
  });

  it("exhaustion borrow pulls a retired row back and re-registers its watcher", async () => {
    nowMs += 25 * HOUR_MS;
    await shrinkIdlePools(deps, { force: true }); // leaves 2 available, 6 retired
    // Block the auto-refill (eager in tests) so exhaustion actually borrows.
    await deps.cache.put("pool:refill-lock:evm", "1", { ttlSeconds: 60 });
    await allocateForInvoice(deps, "invoice-1", "evm");
    await allocateForInvoice(deps, "invoice-2", "evm");
    createdEvents = [];

    const borrowed = await allocateForInvoice(deps, "invoice-3", "evm");

    expect(borrowed.status).toBe("allocated");
    expect(createdEvents.map((e) => e.address)).toContain(borrowed.address);
    const [row] = await deps.db
      .select()
      .from(addressPool)
      .where(eq(addressPool.id, borrowed.id));
    expect(row?.retiredAt).toBeNull();
  });

  it("operator-parked rows get deregistered by pass 2 and re-watched on enable", async () => {
    const rows = await poolRows();
    const target = rows[0]!;
    await disablePoolAddress(deps, { family: "evm", address: target.address });

    // Parked but still watched (no immediate deregistration).
    let [row] = await deps.db.select().from(addressPool).where(eq(addressPool.id, target.id));
    expect(row?.status).toBe("quarantined");
    expect(row?.retiredAt).toBeNull();

    nowMs += 25 * HOUR_MS;
    await shrinkIdlePools(deps, { force: true });
    [row] = await deps.db.select().from(addressPool).where(eq(addressPool.id, target.id));
    expect(row?.retiredAt).not.toBeNull();
    expect(quarantinedEvents.map((e) => e.address)).toContain(target.address);

    createdEvents = [];
    const view = await enablePoolAddress(deps, { family: "evm", address: target.address });
    expect(view.status).toBe("available");
    expect(view.retiredAt).toBeNull();
    expect(view.disabledAt).toBeNull();
    expect(createdEvents.map((e) => e.address)).toContain(target.address);
  });

  it("rescan alerts on stray on-chain funds and un-retires the address", async () => {
    nowMs += 25 * HOUR_MS;
    await shrinkIdlePools(deps, { force: true });
    const retiredRows = (await poolRows()).filter((r) => r.retiredAt !== null);
    expect(retiredRows.length).toBeGreaterThan(0);

    // Stub the chain to report an on-chain balance the ledger can't explain.
    const dev = deps.chains.find((c) => c.family === "evm")!;
    const strayDeps: AppDeps = {
      ...deps,
      chains: [
        {
          ...dev,
          getAccountBalances: async () =>
            [{ token: "DEV", amountRaw: "5000" }] as Awaited<
              ReturnType<typeof dev.getAccountBalances>
            >
        }
      ]
    };
    createdEvents = [];

    const result = await rescanRetiredAddresses(strayDeps, { force: true });

    expect(result.ran).toBe(true);
    expect(result.scanned).toBe(retiredRows.length);
    expect(result.straysFound).toBe(retiredRows.length);
    const after = await poolRows();
    expect(after.filter((r) => r.retiredAt !== null)).toHaveLength(0);
    expect(createdEvents).toHaveLength(retiredRows.length);
    for (const r of after.filter((row) => retiredRows.some((t) => t.id === row.id))) {
      expect(r.status).toBe("available");
    }
  });

  it("rescan is a no-op when nothing is retired", async () => {
    const result = await rescanRetiredAddresses(deps, { force: true });
    expect(result.ran).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.straysFound).toBe(0);
  });
});
