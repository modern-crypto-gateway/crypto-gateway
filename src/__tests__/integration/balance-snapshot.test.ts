import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressPool, feeWallets, merchants, payouts, transactions } from "../../db/schema.js";
import { computeBalanceSnapshot } from "../../core/domain/balance-snapshot.service.js";
import { initializePool } from "../../core/domain/pool.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const ADMIN_KEY = "super-secret-admin-key";

// Balance snapshot has two modes:
//   - default (source="db"): computes balances purely from recorded
//     transactions and payouts. Pristine addresses emit no row.
//   - live (source="rpc", opts.live=true): fans out to the dev chain
//     adapter which returns a synthetic DEV balance for every address.
// Tests cover both.

describe("balance-snapshot — db mode (default)", () => {
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

  it("returns an empty snapshot when no transactions or payouts exist", async () => {
    const snapshot = await computeBalanceSnapshot(booted.deps);
    expect(snapshot.source).toBe("db");
    expect(snapshot.families).toHaveLength(0);
    expect(snapshot.totalUsd).toBe("0.00");
  });

  it("credits pool addresses from confirmed transactions", async () => {
    const poolRows = await booted.deps.db.select().from(addressPool);
    const target = poolRows[0]!;
    const now = Date.now();
    await booted.deps.db.insert(transactions).values({
      id: "tx-1",
      invoiceId: null,
      chainId: 999,
      txHash: "0xabc",
      logIndex: 0,
      fromAddress: "0xsender",
      toAddress: target.address,
      token: "DEV",
      amountRaw: "5000000",
      blockNumber: 10,
      confirmations: 12,
      status: "confirmed",
      detectedAt: now
    });

    const snapshot = await computeBalanceSnapshot(booted.deps);
    expect(snapshot.source).toBe("db");
    expect(snapshot.families).toHaveLength(1);
    const chain = snapshot.families[0]!.chains[0]!;
    expect(chain.chainId).toBe(999);
    const addrRow = chain.addresses.find((a) => a.address === target.address);
    expect(addrRow).toBeDefined();
    expect(addrRow!.kind).toBe("pool");
    expect(addrRow!.tokens[0]!.token).toBe("DEV");
    expect(addrRow!.tokens[0]!.amountRaw).toBe("5000000");
  });

  it("does not emit addresses with zero recorded activity", async () => {
    const snapshot = await computeBalanceSnapshot(booted.deps);
    expect(snapshot.families).toHaveLength(0);
  });

  it("excludes non-confirmed statuses (detected, orphaned, reverted)", async () => {
    const poolRows = await booted.deps.db.select().from(addressPool);
    const target = poolRows[0]!;
    const now = Date.now();
    await booted.deps.db.insert(transactions).values([
      {
        id: "tx-detected",
        chainId: 999,
        txHash: "0x1",
        logIndex: 0,
        fromAddress: "0xs",
        toAddress: target.address,
        token: "DEV",
        amountRaw: "1000",
        status: "detected",
        detectedAt: now
      },
      {
        id: "tx-orphaned",
        chainId: 999,
        txHash: "0x2",
        logIndex: 0,
        fromAddress: "0xs",
        toAddress: target.address,
        token: "DEV",
        amountRaw: "2000",
        status: "orphaned",
        detectedAt: now
      }
    ]);

    const snapshot = await computeBalanceSnapshot(booted.deps);
    expect(snapshot.families).toHaveLength(0);
  });

  it("subtracts confirmed payouts from fee wallet balances and clamps at 0", async () => {
    const now = Date.now();
    const feeAddr = "0x0000000000000000000000000000000000000fee";
    await booted.deps.db.insert(feeWallets).values({
      id: "fee-1",
      chainId: 999,
      address: feeAddr,
      label: "hot-1",
      derivationIndex: 0x40000000,
      active: 1,
      createdAt: now
    });
    await booted.deps.db.insert(transactions).values({
      id: "tx-in",
      chainId: 999,
      txHash: "0xin",
      logIndex: 0,
      fromAddress: "0xext",
      toAddress: feeAddr,
      token: "DEV",
      amountRaw: "10000000",
      status: "confirmed",
      detectedAt: now
    });
    const merchantRow = (await booted.deps.db.select().from(merchants))[0]!;
    await booted.deps.db.insert(payouts).values({
      id: "po-1",
      merchantId: merchantRow.id,
      status: "confirmed",
      chainId: 999,
      token: "DEV",
      amountRaw: "3000000",
      destinationAddress: "0xdest",
      sourceAddress: feeAddr,
      createdAt: now,
      updatedAt: now
    });

    const snapshot = await computeBalanceSnapshot(booted.deps);
    const chain = snapshot.families[0]!.chains[0]!;
    const feeRow = chain.addresses.find((a) => a.kind === "fee");
    expect(feeRow).toBeDefined();
    expect(feeRow!.feeLabel).toBe("hot-1");
    // 10 credited − 3 paid out = 7
    expect(feeRow!.tokens[0]!.amountRaw).toBe("7000000");
  });

  it("rolls up per-token totals across addresses", async () => {
    const poolRows = await booted.deps.db.select().from(addressPool);
    const now = Date.now();
    await booted.deps.db.insert(transactions).values(
      poolRows.map((row, idx) => ({
        id: `tx-${idx}`,
        chainId: 999,
        txHash: `0x${idx}`,
        logIndex: 0,
        fromAddress: "0xs",
        toAddress: row.address,
        token: "DEV",
        amountRaw: "1000000",
        status: "confirmed" as const,
        detectedAt: now
      }))
    );

    const snapshot = await computeBalanceSnapshot(booted.deps);
    const chain = snapshot.families[0]!.chains[0]!;
    const devRoll = chain.tokens.find((t) => t.token === "DEV");
    expect(devRoll).toBeDefined();
    expect(devRoll!.amountRaw).toBe("3000000");
  });

  it("respects kind=fee scope", async () => {
    const now = Date.now();
    const feeAddr = "0x0000000000000000000000000000000000000fee";
    await booted.deps.db.insert(feeWallets).values({
      id: "fee-scope",
      chainId: 999,
      address: feeAddr,
      label: "hot-1",
      derivationIndex: 0x40000000,
      active: 1,
      createdAt: now
    });
    await booted.deps.db.insert(transactions).values({
      id: "tx-fee",
      chainId: 999,
      txHash: "0xf",
      logIndex: 0,
      fromAddress: "0xe",
      toAddress: feeAddr,
      token: "DEV",
      amountRaw: "500",
      status: "confirmed",
      detectedAt: now
    });
    const poolRows = await booted.deps.db.select().from(addressPool);
    await booted.deps.db.insert(transactions).values({
      id: "tx-pool",
      chainId: 999,
      txHash: "0xp",
      logIndex: 0,
      fromAddress: "0xe",
      toAddress: poolRows[0]!.address,
      token: "DEV",
      amountRaw: "500",
      status: "confirmed",
      detectedAt: now
    });

    const snapshot = await computeBalanceSnapshot(booted.deps, { kind: "fee" });
    const chain = snapshot.families[0]!.chains[0]!;
    expect(chain.addresses.every((a) => a.kind === "fee")).toBe(true);
    expect(chain.addresses).toHaveLength(1);
  });
});

describe("balance-snapshot — rpc mode (opts.live=true)", () => {
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

  it("includes every pool address via the adapter and surfaces per-address balances", async () => {
    const snapshot = await computeBalanceSnapshot(booted.deps, { live: true });
    expect(snapshot.source).toBe("rpc");
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
      expect(addr.tokens).toHaveLength(1);
      expect(addr.tokens[0]!.token).toBe("DEV");
      expect(addr.tokens[0]!.amountRaw).toBe("1000000000000000000000");
    }
    expect(chain.errors).toBe(0);
  });

  it("surfaces fee wallets under their chain", async () => {
    const now = Date.now();
    await booted.deps.db.insert(feeWallets).values({
      id: "fee-1",
      chainId: 999,
      address: "0x0000000000000000000000000000000000000fee",
      label: "hot-1",
      derivationIndex: 0x40000000,
      active: 1,
      createdAt: now
    });
    const snapshot = await computeBalanceSnapshot(booted.deps, { live: true });
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
      derivationIndex: 0x40000000,
      active: 1,
      createdAt: now
    });
    const snapshot = await computeBalanceSnapshot(booted.deps, { kind: "fee", live: true });
    const chain = snapshot.families[0]!.chains[0]!;
    expect(chain.addresses.every((a) => a.kind === "fee")).toBe(true);
    expect(chain.addresses).toHaveLength(1);
  });

  it("returns an empty snapshot when family has no chains wired", async () => {
    const snapshot = await computeBalanceSnapshot(booted.deps, { family: "tron", live: true });
    expect(snapshot.families).toHaveLength(0);
    expect(snapshot.totalUsd).toBe("0.00");
  });

  it("rolls up per-token totals across addresses", async () => {
    await initializePool(booted.deps, { families: ["evm"], initialSize: 3 });
    const snapshot = await computeBalanceSnapshot(booted.deps, { live: true });
    const chain = snapshot.families[0]!.chains[0]!;
    const devRoll = chain.tokens.find((t) => t.token === "DEV");
    expect(devRoll).toBeDefined();
    expect(devRoll!.amountRaw).toBe("3000000000000000000000");
  });
});

describe("balance-snapshot — rpc mode error visibility", () => {
  // A pool address whose getAccountBalances fails must NOT silently vanish
  // from the rendered snapshot — pre-fix behavior just bumped
  // `chain.errors` and dropped the row, so operators couldn't tell which
  // specific address had failed without cross-referencing Worker logs.
  // The row now carries `error: <message>` and `tokens: []`.
  it("emits a row with `error` for each address whose getAccountBalances throws, instead of silently dropping it", async () => {
    const { devChainAdapter } = await import("../../adapters/chains/dev/dev-chain.adapter.js");
    const base = devChainAdapter();
    const failing = new Set<string>();
    const wrapped = {
      ...base,
      async getAccountBalances(args: { chainId: number; address: string }) {
        if (failing.has(args.address)) {
          throw new Error("simulated TronGrid 429");
        }
        return base.getAccountBalances(args);
      }
    };

    const booted = await bootTestApp({
      secretsOverrides: { ADMIN_KEY },
      chains: [wrapped],
      poolInitialSize: 3
    });
    try {
      const poolRows = await booted.deps.db.select().from(addressPool);
      expect(poolRows.length).toBe(3);
      // Fail the first pool address only; the other two succeed.
      const failed = poolRows[0]!.address;
      failing.add(failed);

      const snapshot = await computeBalanceSnapshot(booted.deps, { live: true });
      const chain = snapshot.families[0]!.chains[0]!;

      // All three addresses are rendered — none silently disappear.
      expect(chain.addresses).toHaveLength(3);
      expect(chain.errors).toBe(1);

      const errorRow = chain.addresses.find((a) => a.address === failed);
      expect(errorRow).toBeDefined();
      expect(errorRow!.tokens).toHaveLength(0);
      expect(errorRow!.totalUsd).toBe("0.00");
      expect(errorRow!.error).toContain("TronGrid");

      const healthyRows = chain.addresses.filter((a) => a.address !== failed);
      expect(healthyRows).toHaveLength(2);
      for (const row of healthyRows) {
        expect(row.error).toBeUndefined();
        expect(row.tokens).toHaveLength(1);
        expect(row.tokens[0]!.token).toBe("DEV");
      }
    } finally {
      await booted.close();
    }
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

  it("returns a db-sourced snapshot via GET /admin/balances (default mode)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/balances", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshot: { source: string; families: unknown[] };
      cached: boolean;
    };
    expect(body.cached).toBe(false);
    expect(body.snapshot.source).toBe("db");
    expect(body.snapshot.families).toHaveLength(0);
  });

  it("returns an rpc-sourced snapshot when ?live=true", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/balances?live=true", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshot: { source: string; families: unknown[] };
      cached: boolean;
    };
    expect(body.snapshot.source).toBe("rpc");
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

  it("db and rpc modes do not share a cache slot", async () => {
    const dbRes = await booted.app.fetch(
      new Request("http://test.local/admin/balances", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    const dbBody = (await dbRes.json()) as { snapshot: { source: string } };
    expect(dbBody.snapshot.source).toBe("db");

    const rpcRes = await booted.app.fetch(
      new Request("http://test.local/admin/balances?live=true", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    const rpcBody = (await rpcRes.json()) as { snapshot: { source: string }; cached: boolean };
    expect(rpcBody.snapshot.source).toBe("rpc");
    expect(rpcBody.cached).toBe(false);
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
