import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feeWallets } from "../../db/schema.js";
import { computeBalanceSnapshot } from "../../core/domain/balance-snapshot.service.js";
import { initializePool } from "../../core/domain/pool.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const ADMIN_KEY = "super-secret-admin-key";

// Balance snapshot: the dev chain adapter returns a single token "DEV" with a
// large amount via getAccountBalances. The static-peg price oracle returns
// "1.00" for known stables; "DEV" is not stable, so it falls through to "0".
// We exercise the discovery + aggregation paths and the admin route's
// caching + scope filters — the actual USD math gets a dedicated unit test.

describe("balance-snapshot — service", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({
      secretsOverrides: { ADMIN_KEY },
      poolInitialSize: 3
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("includes every pool address and surfaces per-address balances", async () => {
    const snapshot = await computeBalanceSnapshot(booted.deps);
    expect(snapshot.families).toHaveLength(1);
    const evm = snapshot.families[0]!;
    expect(evm.family).toBe("evm");
    expect(evm.chains).toHaveLength(1);
    const chain = evm.chains[0]!;
    expect(chain.chainId).toBe(999);
    expect(chain.addresses).toHaveLength(3);
    for (const addr of chain.addresses) {
      expect(addr.kind).toBe("pool");
      expect(addr.poolStatus).toBe("available");
      // Dev adapter returns one DEV-token entry with a large amount.
      expect(addr.tokens).toHaveLength(1);
      expect(addr.tokens[0]!.token).toBe("DEV");
      expect(addr.tokens[0]!.amountRaw).toBe("1000000000000000000000");
    }
    // No errors — every adapter call succeeded.
    expect(chain.errors).toBe(0);
  });

  it("surfaces fee wallets under their chain", async () => {
    const now = Date.now();
    await booted.deps.db.insert(feeWallets).values({
      id: "fee-1",
      chainId: 999,
      address: "0x0000000000000000000000000000000000000fee",
      label: "hot-1",
      active: 1,
      createdAt: now
    });
    const snapshot = await computeBalanceSnapshot(booted.deps);
    const chain = snapshot.families[0]!.chains[0]!;
    const feeRow = chain.addresses.find((a) => a.kind === "fee");
    expect(feeRow).toBeDefined();
    expect(feeRow!.feeLabel).toBe("hot-1");
  });

  it("respects scope filters: kind=fee excludes pool", async () => {
    const now = Date.now();
    await booted.deps.db.insert(feeWallets).values({
      id: "fee-2",
      chainId: 999,
      address: "0x0000000000000000000000000000000000000fee",
      label: "hot-1",
      active: 1,
      createdAt: now
    });
    const snapshot = await computeBalanceSnapshot(booted.deps, { kind: "fee" });
    const chain = snapshot.families[0]!.chains[0]!;
    expect(chain.addresses.every((a) => a.kind === "fee")).toBe(true);
    expect(chain.addresses).toHaveLength(1);
  });

  it("returns an empty snapshot when family has no chains wired", async () => {
    const snapshot = await computeBalanceSnapshot(booted.deps, { family: "tron" });
    expect(snapshot.families).toHaveLength(0);
    expect(snapshot.totalUsd).toBe("0.00");
  });

  it("rolls up per-token totals across addresses", async () => {
    // Re-seed so we know exactly 3 pool rows exist; each returns the same
    // amount → roll-up is 3× single.
    await initializePool(booted.deps, { families: ["evm"], initialSize: 3 });
    const snapshot = await computeBalanceSnapshot(booted.deps);
    const chain = snapshot.families[0]!.chains[0]!;
    const devRoll = chain.tokens.find((t) => t.token === "DEV");
    expect(devRoll).toBeDefined();
    // 3 addresses × 1e21 each = 3e21
    expect(devRoll!.amountRaw).toBe("3000000000000000000000");
  });
});

describe("balance-snapshot — admin route", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({
      secretsOverrides: { ADMIN_KEY },
      poolInitialSize: 2
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("returns a snapshot via GET /admin/balances", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/balances", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: { families: unknown[] }; cached: boolean };
    expect(body.cached).toBe(false);
    expect(body.snapshot.families).toHaveLength(1);
  });

  it("serves the second call from cache", async () => {
    const first = await booted.app.fetch(
      new Request("http://test.local/admin/balances", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { cached: boolean }).cached).toBe(false);

    const second = await booted.app.fetch(
      new Request("http://test.local/admin/balances", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true);
  });

  it("rejects unauthenticated calls", async () => {
    const res = await booted.app.fetch(new Request("http://test.local/admin/balances"));
    expect(res.status).toBe(401);
  });

  it("rejects malformed family query (400)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/balances?family=bogus", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(400);
  });
});
