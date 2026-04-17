import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { alchemyAddressSubscriptions } from "../../db/schema.js";
import { initializePool, refillFamily } from "../../core/domain/pool.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

async function countSubs(booted: BootedTestApp, where: ReturnType<typeof and>): Promise<number> {
  const [row] = await booted.deps.db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(alchemyAddressSubscriptions)
    .where(where);
  return Number(row?.cnt ?? 0);
}

// Pool-driven Alchemy subscription tracking (post-A1 rewrite). Subscription
// rows are tied to pool lifecycle — not invoice lifecycle — so one EVM pool
// address is subscribed ONCE (fanned across all Alchemy-served EVM chains)
// and then reused across thousands of invoices without re-enqueueing.

describe("alchemy subscription tracker — pool-driven enqueue", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({
      // Skip the default bootTestApp pool-seed so we control it precisely
      // below and can assert exact row counts.
      skipPoolInit: true,
      alchemy: { syncAddresses: async () => undefined },
      alchemySubscribableChainsByFamily: {
        evm: [1, 137],
        solana: [900]
      }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("emits one 'add' row per Alchemy-served chain when a new EVM pool address is created", async () => {
    // Initialize the EVM pool with 2 addresses. Expected fan-out: 2 addresses
    // × 2 configured EVM chains (1, 137) = 4 subscription rows.
    await initializePool(booted.deps, { families: ["evm"], initialSize: 2 });
    await booted.deps.jobs.drain(500);

    const rowsForChain1 = await countSubs(
      booted,
      and(eq(alchemyAddressSubscriptions.chainId, 1), eq(alchemyAddressSubscriptions.action, "add"))
    );
    const rowsForChain137 = await countSubs(
      booted,
      and(eq(alchemyAddressSubscriptions.chainId, 137), eq(alchemyAddressSubscriptions.action, "add"))
    );
    expect(rowsForChain1).toBe(2);
    expect(rowsForChain137).toBe(2);
  });

  it("does NOT enqueue Solana rows when only EVM family was added", async () => {
    // The tracker fans out per family. An EVM pool refill shouldn't produce
    // Solana subscription rows.
    await initializePool(booted.deps, { families: ["evm"], initialSize: 1 });
    await booted.deps.jobs.drain(500);

    const rowsForSolana = await countSubs(booted, eq(alchemyAddressSubscriptions.chainId, 900));
    expect(rowsForSolana).toBe(0);
  });

  it("emits nothing when alchemySubscribableChainsByFamily is absent (alchemy not configured)", async () => {
    const noAlchemy = await bootTestApp({ skipPoolInit: true });
    try {
      await refillFamily(noAlchemy.deps, "evm", 1);
      await noAlchemy.deps.jobs.drain(500);
      const [rows] = await noAlchemy.deps.db
        .select({ cnt: sql<number>`COUNT(*)` })
        .from(alchemyAddressSubscriptions);
      expect(Number(rows?.cnt ?? 0)).toBe(0);
    } finally {
      await noAlchemy.close();
    }
  });

  it("does NOT enqueue subscription rows for chains outside the configured set", async () => {
    // tracker's alchemyChainsByFamily only has chains 1 and 137 for EVM.
    // A pool.address.created event doesn't magically subscribe the address
    // on chain 10, 8453, etc. — only what's configured.
    await initializePool(booted.deps, { families: ["evm"], initialSize: 1 });
    await booted.deps.jobs.drain(500);

    const rowsForChain10 = await countSubs(booted, eq(alchemyAddressSubscriptions.chainId, 10));
    expect(rowsForChain10).toBe(0);
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
