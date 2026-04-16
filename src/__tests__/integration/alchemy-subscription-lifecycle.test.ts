import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dbAlchemySubscriptionStore,
  type AlchemySubscriptionStore
} from "../../adapters/detection/alchemy-subscription-store.js";
import { bootTestApp, createOrderViaApi, type BootedTestApp } from "../helpers/boot.js";

// Integration tests that exercise the full lifecycle end-to-end:
//   1. Operator configures Alchemy (we pass a stub syncAddresses to deps.alchemy
//      — that's enough for the tracker to register; the sweep isn't what we're
//      testing here).
//   2. Order created → tracker fires on order.created → subscription row inserted
//      with action='add', status='pending'.
//   3. Order reaches terminal state → tracker fires on order.*→ row with action='remove'.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

async function boot(): Promise<BootedTestApp> {
  return bootTestApp({
    // Seed alchemy in deps so the tracker gets registered inside buildApp.
    // The syncAddresses stub never gets called in these tests — the tracker
    // writes rows; the sweep would run them (separate test).
    alchemy: { syncAddresses: async () => undefined }
  });
}

describe("alchemy subscription tracker — event-driven enqueue", () => {
  let booted: BootedTestApp;
  let subs: AlchemySubscriptionStore;

  beforeEach(async () => {
    booted = await boot();
    subs = dbAlchemySubscriptionStore(booted.deps.db);
  });

  afterEach(async () => {
    await booted.close();
  });

  it("does NOT enqueue a row when the order's chain isn't served by Alchemy", async () => {
    // Default dev chain 999 isn't in ALCHEMY_NETWORK_BY_CHAIN_ID → skipped.
    const order = await createOrderViaApi(booted, { amountRaw: "1" });
    await booted.deps.jobs.drain(200);

    const rows = await subs.findByAddress(999, order.receiveAddress);
    expect(rows).toEqual([]);
  });

  it("enqueues an 'add' row on order.created for Alchemy-supported chains", async () => {
    // Directly publish an event for a supported chain (chainId=1 is ETH_MAINNET
    // in ALCHEMY_NETWORK_BY_CHAIN_ID). This avoids needing the full EVM adapter
    // wiring just to drive the tracker.
    const fakeOrder = {
      id: "00000000-0000-0000-0000-000000000aaa",
      merchantId: MERCHANT_ID,
      status: "created",
      chainId: 1,
      token: "USDC",
      receiveAddress: "0xReceiveAddr111111111111111111111111111111",
      addressIndex: 0,
      requiredAmountRaw: "1000000",
      receivedAmountRaw: "0",
      fiatAmount: null,
      fiatCurrency: null,
      quotedRate: null,
      externalId: null,
      metadata: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      confirmedAt: null,
      updatedAt: new Date()
    };
    await booted.deps.events.publish({
      type: "order.created",
      orderId: fakeOrder.id as never,
      order: fakeOrder as never,
      at: new Date()
    });
    await booted.deps.jobs.drain(200);

    const rows = await subs.findByAddress(1, fakeOrder.receiveAddress);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "add", status: "pending", attempts: 0 });
  });

  it("enqueues a 'remove' row on each terminal order transition", async () => {
    const receiveAddress = "0xTerminalAddr2222222222222222222222222222";
    const baseOrder = {
      id: "00000000-0000-0000-0000-00000000bbbb",
      merchantId: MERCHANT_ID,
      chainId: 1,
      token: "USDC",
      receiveAddress,
      addressIndex: 0,
      requiredAmountRaw: "1",
      receivedAmountRaw: "0",
      fiatAmount: null,
      fiatCurrency: null,
      quotedRate: null,
      externalId: null,
      metadata: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      confirmedAt: null,
      updatedAt: new Date()
    };

    // Fire one event per terminal type; each should produce its own 'remove' row.
    for (const type of ["order.confirmed", "order.expired", "order.canceled"] as const) {
      await booted.deps.events.publish({
        type,
        orderId: baseOrder.id as never,
        order: { ...baseOrder, status: type.slice("order.".length) } as never,
        at: new Date()
      });
    }
    await booted.deps.jobs.drain(200);

    const rows = await subs.findByAddress(1, receiveAddress);
    // 3 removes, one per event.
    expect(rows.filter((r) => r.action === "remove")).toHaveLength(3);
  });

  it("tracker is inactive when deps.alchemy is not configured (no rows written)", async () => {
    const noAlchemy = await bootTestApp({});
    try {
      const subsNoAlch = dbAlchemySubscriptionStore(noAlchemy.deps.db);
      await noAlchemy.deps.events.publish({
        type: "order.created",
        orderId: "x" as never,
        order: {
          id: "x",
          merchantId: MERCHANT_ID,
          status: "created",
          chainId: 1,
          token: "USDC",
          receiveAddress: "0xShouldNotAppear33333333333333333333333333",
          addressIndex: 0,
          requiredAmountRaw: "1",
          receivedAmountRaw: "0",
          fiatAmount: null,
          fiatCurrency: null,
          quotedRate: null,
          externalId: null,
          metadata: null,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          confirmedAt: null,
          updatedAt: new Date()
        } as never,
        at: new Date()
      });
      await noAlchemy.deps.jobs.drain(200);
      const rows = await subsNoAlch.findByAddress(1, "0xShouldNotAppear33333333333333333333333333");
      expect(rows).toEqual([]);
    } finally {
      await noAlchemy.close();
    }
  });
});

describe("runScheduledJobs invokes deps.alchemy?.syncAddresses when present", () => {
  it("calls syncAddresses as part of the sweep; result appears in the cron tick response", async () => {
    let syncCalled = 0;
    const booted = await bootTestApp({
      alchemy: {
        syncAddresses: async () => {
          syncCalled += 1;
          return { claimed: 42 };
        }
      },
      secretsOverrides: { CRON_SECRET: "s3cret" }
    });
    try {
      const res = await booted.app.fetch(
        new Request("http://test.local/internal/cron/tick", {
          method: "POST",
          headers: { authorization: "Bearer s3cret" }
        })
      );
      expect(res.status).toBe(200);
      expect(syncCalled).toBe(1);
      const body = (await res.json()) as {
        result: { alchemySyncAddresses?: { ok: boolean; value?: unknown } };
      };
      expect(body.result.alchemySyncAddresses).toEqual({ ok: true, value: { claimed: 42 } });
    } finally {
      await booted.close();
    }
  });

  it("does NOT include alchemySyncAddresses when alchemy isn't configured", async () => {
    const booted = await bootTestApp({ secretsOverrides: { CRON_SECRET: "s" } });
    try {
      const res = await booted.app.fetch(
        new Request("http://test.local/internal/cron/tick", {
          method: "POST",
          headers: { authorization: "Bearer s" }
        })
      );
      const body = (await res.json()) as { result: Record<string, unknown> };
      expect(body.result).not.toHaveProperty("alchemySyncAddresses");
    } finally {
      await booted.close();
    }
  });
});
