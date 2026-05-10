import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { runAutoConsolidations } from "../../core/domain/auto-consolidation.service.js";
import { autoConsolidationSchedules, payouts } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { seedFundedPoolAddress } from "../helpers/seed-source.js";
import type { ChainAdapter } from "../../core/ports/chain.port.js";
import type { ChainId } from "../../core/types/chain.js";

const ADMIN_KEY = "super-secret-admin-key";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

// Auto-consolidation runs the existing planPoolConsolidation flow on a
// recurring schedule. These tests cover:
//   1. End-to-end happy path: create schedule via admin endpoint, advance
//      clock past nextRunDue, run cron, verify legs planned.
//   2. Per-source-balance dust gate: sources below the threshold are
//      filtered out; only those at or above get consolidated.
//   3. In-flight skip: if a prior consolidation_sweep batch is still
//      pending for the same (chainId, token), the cron skips this tick.
//   4. CRUD: list/get/patch/delete via admin endpoints.
//
// Same dev-adapter wrapper the manual consolidate test uses — flips
// nativeSymbol from "DEV" to "DEVN" so DEVT is treated as a non-native
// token (gas-top-up sponsor path exercises).

function consolidateAdapter(): ChainAdapter {
  const base = devChainAdapter({ deterministicTxHashes: true });
  return {
    ...base,
    nativeSymbol(_chainId: ChainId) {
      return "DEVN" as ReturnType<ChainAdapter["nativeSymbol"]>;
    }
  };
}

describe("auto-consolidation schedules", () => {
  let booted: BootedTestApp;
  let adapter: ChainAdapter;
  let target: string;
  let sourceA: string;
  let sourceB: string;
  let sourceC: string;
  let sourceDust: string;
  let sponsor: string;

  // 8-million range to avoid colliding with other tests' derivation slots.
  const TARGET_INDEX = 8_000_001;
  const SOURCE_A_INDEX = 8_000_002;
  const SOURCE_B_INDEX = 8_000_003;
  const SOURCE_C_INDEX = 8_000_004;
  const SOURCE_DUST_INDEX = 8_000_005;
  const SPONSOR_INDEX = 8_000_006;

  beforeEach(async () => {
    adapter = consolidateAdapter();
    booted = await bootTestApp({ chains: [adapter], secretsOverrides: { ADMIN_KEY } });
    const a = booted.deps.chains[0]!;
    target = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, TARGET_INDEX).address);
    sourceA = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_A_INDEX).address);
    sourceB = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_B_INDEX).address);
    sourceC = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_C_INDEX).address);
    sourceDust = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SOURCE_DUST_INDEX).address);
    sponsor = a.canonicalizeAddress(a.deriveAddress(TEST_MASTER_SEED, SPONSOR_INDEX).address);

    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: target, derivationIndex: TARGET_INDEX,
      balances: {}
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceA, derivationIndex: SOURCE_A_INDEX,
      balances: { DEVT: "100" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceB, derivationIndex: SOURCE_B_INDEX,
      balances: { DEVT: "60" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceC, derivationIndex: SOURCE_C_INDEX,
      balances: { DEVT: "40" }
    });
    // Dust source: only "5" DEVT — below typical thresholds, used to
    // verify minSourceBalanceRaw filtering.
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sourceDust, derivationIndex: SOURCE_DUST_INDEX,
      balances: { DEVT: "5" }
    });
    await seedFundedPoolAddress(booted, {
      chainId: 999, family: "evm", address: sponsor, derivationIndex: SPONSOR_INDEX,
      balances: { DEVN: "10000000" }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function postSchedule(body: unknown): Promise<Response> {
    return await booted.app.fetch(
      new Request("http://test.local/admin/consolidation-schedules", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify(body)
      })
    );
  }
  async function getSchedule(id: string): Promise<Response> {
    return await booted.app.fetch(
      new Request(`http://test.local/admin/consolidation-schedules/${id}`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
  }
  async function listSchedules(query = ""): Promise<Response> {
    return await booted.app.fetch(
      new Request(`http://test.local/admin/consolidation-schedules${query}`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
  }
  async function patchSchedule(id: string, body: unknown): Promise<Response> {
    return await booted.app.fetch(
      new Request(`http://test.local/admin/consolidation-schedules/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify(body)
      })
    );
  }
  async function deleteSchedule(id: string): Promise<Response> {
    return await booted.app.fetch(
      new Request(`http://test.local/admin/consolidation-schedules/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
  }

  it("POST creates a schedule with nextRunDue = now + intervalHours", async () => {
    const before = booted.deps.clock.now().getTime();
    const res = await postSchedule({
      chainId: 999,
      token: "DEVT",
      targetAddress: target,
      intervalHours: 12,
      minSourceBalanceRaw: "20",
      maxSourcesPerRun: 25
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { schedule: { id: string; nextRunDue: number; intervalHours: number; enabled: boolean } };
    expect(body.schedule.intervalHours).toBe(12);
    expect(body.schedule.enabled).toBe(true);
    expect(body.schedule.nextRunDue).toBeGreaterThanOrEqual(before + 12 * 3600_000);
    expect(body.schedule.nextRunDue).toBeLessThan(before + 12 * 3600_000 + 5_000); // small clock drift tolerance
  });

  it("POST returns 409 when a schedule already exists for (chainId, token)", async () => {
    await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "10"
    });
    const res = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "10"
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SCHEDULE_ALREADY_EXISTS");
  });

  it("POST returns 400 when target is not in the pool", async () => {
    const res = await postSchedule({
      chainId: 999, token: "DEVT",
      targetAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intervalHours: 1, minSourceBalanceRaw: "10"
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TARGET_NOT_IN_POOL");
  });

  it("cron does NOT fire schedules whose nextRunDue is in the future", async () => {
    await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 12, minSourceBalanceRaw: "10"
    });
    // Don't advance clock — nextRunDue is 12h in the future.
    const result = await runAutoConsolidations(booted.deps);
    expect(result.checked).toBe(0);
    expect(result.fired).toBe(0);

    // No consolidation_sweep payouts created.
    const sweeps = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.kind, "consolidation_sweep"));
    expect(sweeps).toHaveLength(0);
  });

  it("end-to-end: cron fires when due, plans legs, snapshots last-run on the schedule", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "20"
    });
    const created = (await createRes.json()) as { schedule: { id: string; nextRunDue: number } };
    const scheduleId = created.schedule.id;

    // Force the schedule to be due by rewinding nextRunDue. (Easier than
    // mucking with deps.clock since the test app uses a real clock by default.)
    await booted.deps.db
      .update(autoConsolidationSchedules)
      .set({ nextRunDue: booted.deps.clock.now().getTime() - 1000 })
      .where(eq(autoConsolidationSchedules.id, scheduleId));

    const result = await runAutoConsolidations(booted.deps);
    expect(result.checked).toBe(1);
    expect(result.fired).toBe(1);
    expect(result.errors).toBe(0);

    // 3 legs (sourceA=100, sourceB=60, sourceC=40 — all >= 20).
    // sourceDust=5 is filtered out by minSourceBalanceRaw=20.
    const sweeps = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.kind, "consolidation_sweep"));
    expect(sweeps).toHaveLength(3);
    expect(new Set(sweeps.map((s) => s.sourceAddress))).toEqual(
      new Set([sourceA, sourceB, sourceC])
    );
    expect(sweeps.every((s) => s.sourceAddress !== sourceDust)).toBe(true);

    // Schedule's snapshot fields populated.
    const [updated] = await booted.deps.db
      .select()
      .from(autoConsolidationSchedules)
      .where(eq(autoConsolidationSchedules.id, scheduleId))
      .limit(1);
    expect(updated!.lastConsolidationId).not.toBeNull();
    expect(updated!.lastLegCount).toBe(3);
    expect(updated!.lastRunAt).not.toBeNull();
    // nextRunDue advanced by intervalHours * 3600000 ms.
    expect(updated!.nextRunDue).toBeGreaterThan(booted.deps.clock.now().getTime());
  });

  it("cron skips schedules with NO_SOURCES_WITH_BALANCE (everything below threshold)", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1,
      minSourceBalanceRaw: "200" // higher than any seeded source
    });
    const created = (await createRes.json()) as { schedule: { id: string } };
    await booted.deps.db
      .update(autoConsolidationSchedules)
      .set({ nextRunDue: booted.deps.clock.now().getTime() - 1000 })
      .where(eq(autoConsolidationSchedules.id, created.schedule.id));

    const result = await runAutoConsolidations(booted.deps);
    expect(result.checked).toBe(1);
    // NO_SOURCES_WITH_BALANCE thrown by planPoolConsolidation → counts as
    // an error in the result tally (logged at info, not warn). Still
    // advances nextRunDue so the schedule doesn't retry-storm.
    expect(result.fired).toBe(0);
    expect(result.errors).toBe(1);

    // Schedule's nextRunDue still advanced past now.
    const [updated] = await booted.deps.db
      .select()
      .from(autoConsolidationSchedules)
      .where(eq(autoConsolidationSchedules.id, created.schedule.id))
      .limit(1);
    expect(updated!.nextRunDue).toBeGreaterThan(booted.deps.clock.now().getTime());
  });

  it("cron skips when an in-flight consolidation_sweep already exists for (chainId, token)", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "10"
    });
    const created = (await createRes.json()) as { schedule: { id: string } };
    // First run — fires legs into reserved/topping-up state.
    await booted.deps.db
      .update(autoConsolidationSchedules)
      .set({ nextRunDue: booted.deps.clock.now().getTime() - 1000 })
      .where(eq(autoConsolidationSchedules.id, created.schedule.id));
    const first = await runAutoConsolidations(booted.deps);
    expect(first.fired).toBe(1);

    // Force the schedule to be due again immediately, but DON'T advance
    // the executor — legs are still in reserved/topping-up. The cron
    // should detect the in-flight batch and skip.
    await booted.deps.db
      .update(autoConsolidationSchedules)
      .set({ nextRunDue: booted.deps.clock.now().getTime() - 1000 })
      .where(eq(autoConsolidationSchedules.id, created.schedule.id));
    const second = await runAutoConsolidations(booted.deps);
    expect(second.checked).toBe(1);
    expect(second.fired).toBe(0);
    expect(second.skipped).toBe(1);

    // No new legs created — the first batch's legs are still all that exist.
    const allSweeps = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.kind, "consolidation_sweep"));
    // First run produced 3 legs (sourceA=100, B=60, C=40 — all >= 10).
    // sourceDust=5 was filtered by minSourceBalanceRaw=10.
    expect(allSweeps).toHaveLength(3);
  });

  it("respects maxSourcesPerRun cap (defers extras to next tick)", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1,
      minSourceBalanceRaw: "1",
      maxSourcesPerRun: 2 // cap to 2 of the 4 eligible sources
    });
    const created = (await createRes.json()) as { schedule: { id: string } };
    await booted.deps.db
      .update(autoConsolidationSchedules)
      .set({ nextRunDue: booted.deps.clock.now().getTime() - 1000 })
      .where(eq(autoConsolidationSchedules.id, created.schedule.id));

    const result = await runAutoConsolidations(booted.deps);
    expect(result.fired).toBe(1);

    const sweeps = await booted.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.kind, "consolidation_sweep"));
    expect(sweeps).toHaveLength(2); // capped at 2
  });

  // ---- CRUD ----

  it("GET /consolidation-schedules lists all schedules", async () => {
    await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "10"
    });
    const res = await listSchedules();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: Array<{ chainId: number; token: string }> };
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]!.chainId).toBe(999);
    expect(body.schedules[0]!.token).toBe("DEVT");
  });

  it("GET /consolidation-schedules?enabled=false filters by enabled state", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "10", enabled: false
    });
    const created = (await createRes.json()) as { schedule: { id: string } };
    void created;
    const enabledOnly = await listSchedules("?enabled=true");
    const enabledBody = (await enabledOnly.json()) as { schedules: unknown[] };
    expect(enabledBody.schedules).toHaveLength(0);
    const disabledOnly = await listSchedules("?enabled=false");
    const disabledBody = (await disabledOnly.json()) as { schedules: unknown[] };
    expect(disabledBody.schedules).toHaveLength(1);
  });

  it("PATCH updates fields and recomputes nextRunDue when intervalHours changes", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 24, minSourceBalanceRaw: "10"
    });
    const created = (await createRes.json()) as { schedule: { id: string; nextRunDue: number; createdAt: number } };

    const patchRes = await patchSchedule(created.schedule.id, { intervalHours: 1, minSourceBalanceRaw: "50" });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { schedule: { intervalHours: number; minSourceBalanceRaw: string; nextRunDue: number } };
    expect(patched.schedule.intervalHours).toBe(1);
    expect(patched.schedule.minSourceBalanceRaw).toBe("50");
    // nextRunDue recomputed: createdAt + 1h (since lastRunAt is null).
    expect(patched.schedule.nextRunDue).toBe(created.schedule.createdAt + 3600_000);
    // And it's now in the past, so the cron would pick it up next tick.
    expect(patched.schedule.nextRunDue).toBeLessThan(created.schedule.nextRunDue);
  });

  it("PATCH returns 404 for unknown schedule id", async () => {
    const res = await patchSchedule("00000000-0000-0000-0000-000000000000", { enabled: false });
    expect(res.status).toBe(404);
  });

  it("DELETE removes the schedule, subsequent GET returns 404", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "10"
    });
    const created = (await createRes.json()) as { schedule: { id: string } };
    const delRes = await deleteSchedule(created.schedule.id);
    expect(delRes.status).toBe(200);
    expect((await delRes.json())).toEqual({ deleted: true });
    const getRes = await getSchedule(created.schedule.id);
    expect(getRes.status).toBe(404);
  });

  it("disabled schedules are NOT picked up by the cron even when due", async () => {
    const createRes = await postSchedule({
      chainId: 999, token: "DEVT", targetAddress: target,
      intervalHours: 1, minSourceBalanceRaw: "10", enabled: false
    });
    const created = (await createRes.json()) as { schedule: { id: string } };
    await booted.deps.db
      .update(autoConsolidationSchedules)
      .set({ nextRunDue: booted.deps.clock.now().getTime() - 1000 })
      .where(eq(autoConsolidationSchedules.id, created.schedule.id));

    const result = await runAutoConsolidations(booted.deps);
    expect(result.checked).toBe(0);
    expect(result.fired).toBe(0);
  });

  // Suppress unused-var warning for `and` (used by some queries we may inline later).
  void and;
});
