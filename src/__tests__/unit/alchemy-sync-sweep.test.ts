import { beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb, createLibsqlClient } from "../../db/client.js";
import { bufferingLogger } from "../../adapters/logging/console.adapter.js";
import type {
  AlchemyAdminClient,
  AlchemyWebhookSummary
} from "../../adapters/detection/alchemy-admin-client.js";
import {
  dbAlchemyRegistryStore,
  type AlchemyRegistryStore
} from "../../adapters/detection/alchemy-registry-store.js";
import {
  dbAlchemySubscriptionStore,
  type AlchemySubscriptionStore
} from "../../adapters/detection/alchemy-subscription-store.js";
import { makeAlchemySyncSweep } from "../../adapters/detection/alchemy-sync-sweep.js";

interface Harness {
  subscriptionStore: AlchemySubscriptionStore;
  registryStore: AlchemyRegistryStore;
  fakeClient: {
    calls: Array<{
      webhookId: string;
      addressesToAdd: readonly string[];
      addressesToRemove: readonly string[];
    }>;
    nextError: string | null;
    client: AlchemyAdminClient;
  };
}

async function freshHarness(): Promise<Harness> {
  const client = createLibsqlClient({ url: ":memory:" });
  const db = createDb(client);
  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "drizzle",
    "migrations"
  );
  await migrate(db, { migrationsFolder });

  const subscriptionStore = dbAlchemySubscriptionStore(db);
  const registryStore = dbAlchemyRegistryStore(db);

  const calls: Harness["fakeClient"]["calls"] = [];
  const fakeClient: Harness["fakeClient"] = {
    calls,
    nextError: null,
    client: {
      async listWebhooks() {
        return [] as readonly AlchemyWebhookSummary[];
      },
      async createWebhook() {
        throw new Error("unexpected createWebhook call");
      },
      async updateWebhookAddresses(args) {
        calls.push({
          webhookId: args.webhookId,
          addressesToAdd: args.addressesToAdd ?? [],
          addressesToRemove: args.addressesToRemove ?? []
        });
        if (fakeClient.nextError !== null) {
          const err = fakeClient.nextError;
          fakeClient.nextError = null;
          throw new Error(err);
        }
      }
    }
  };

  return { subscriptionStore, registryStore, fakeClient };
}

describe("makeAlchemySyncSweep", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  it("batches add+remove per chain into a single /update-webhook-addresses call", async () => {
    await h.registryStore.upsert({
      chainId: 1,
      webhookId: "wh_eth",
      signingKeyCiphertext: "whsec",
      webhookUrl: "https://x",
      now: 1_000
    });

    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xb", action: "add", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xc", action: "remove", now: 1_000 });

    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 2_000
    });
    const result = await sweep();

    expect(h.fakeClient.calls).toHaveLength(1);
    expect(h.fakeClient.calls[0]).toEqual({
      webhookId: "wh_eth",
      addressesToAdd: ["0xa", "0xb"],
      addressesToRemove: ["0xc"]
    });
    expect(result).toMatchObject({ claimed: 3, syncedChains: 1, skippedChains: 0, failedChains: 0 });
    expect(await h.subscriptionStore.countByStatus()).toEqual({ pending: 0, synced: 3, failed: 0 });
  });

  it("resolves each claimed address against the watch-intent source of truth, not row order", async () => {
    await h.registryStore.upsert({
      chainId: 1,
      webhookId: "wh_eth",
      signingKeyCiphertext: "whsec",
      webhookUrl: "https://x",
      now: 1_000
    });
    // 0xa: stale `remove` enqueued AFTER a reactivation `add` (retire→
    // reactivate flap) — row order would deregister an address the DB says
    // is watched. 0xb: genuinely retired.
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "remove", now: 1_500 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xb", action: "remove", now: 1_500 });

    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 2_000,
      resolveWatchIntent: async () => new Set(["0xa"])
    });
    const result = await sweep();

    expect(h.fakeClient.calls).toHaveLength(1);
    expect(h.fakeClient.calls[0]).toEqual({
      webhookId: "wh_eth",
      addressesToAdd: ["0xa"],
      addressesToRemove: ["0xb"]
    });
    expect(result).toMatchObject({ claimed: 3, syncedChains: 1 });
    expect(await h.subscriptionStore.countByStatus()).toEqual({ pending: 0, synced: 3, failed: 0 });
  });

  it("skips the run (leaving rows pending) when the advisory sweep lock is held", async () => {
    const { memoryCacheAdapter } = await import("../../adapters/cache/memory.adapter.js");
    const cache = memoryCacheAdapter();
    await cache.put("alchemy:sync-sweep-lock", "1", { ttlSeconds: 60 });
    await h.registryStore.upsert({ chainId: 1, webhookId: "wh_eth", signingKeyCiphertext: "k", webhookUrl: "u", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });

    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 2_000,
      cache
    });
    const blocked = await sweep();
    expect(blocked.claimed).toBe(0);
    expect(h.fakeClient.calls).toHaveLength(0);

    // Lock released → the same sweep drains the row.
    await cache.delete("alchemy:sync-sweep-lock");
    const drained = await sweep();
    expect(drained.claimed).toBe(1);
    expect(h.fakeClient.calls).toHaveLength(1);
  });

  it("makes one API call per chain when multiple chains have pending rows", async () => {
    await h.registryStore.upsert({ chainId: 1, webhookId: "wh_eth", signingKeyCiphertext: "k", webhookUrl: "u", now: 1_000 });
    await h.registryStore.upsert({ chainId: 137, webhookId: "wh_poly", signingKeyCiphertext: "k", webhookUrl: "u", now: 1_000 });

    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 137, address: "0xb", action: "add", now: 1_000 });

    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 2_000
    });
    await sweep();

    expect(h.fakeClient.calls).toHaveLength(2);
    expect(h.fakeClient.calls.map((c) => c.webhookId).sort()).toEqual(["wh_eth", "wh_poly"]);
  });

  it("skips chains with no registry row WITHOUT bumping attempts (bootstrap-first, sweep-second)", async () => {
    // No webhook registered for chain 1.
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });

    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 2_000
    });
    const result = await sweep();

    expect(h.fakeClient.calls).toHaveLength(0);
    expect(result.skippedChains).toBe(1);

    // The row remains pending with attempts=0 — a later bootstrap unblocks it.
    const rows = await h.subscriptionStore.findByAddress(1, "0xa");
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);
  });

  it("on API failure, bumps attempts and keeps rows pending until maxAttempts", async () => {
    await h.registryStore.upsert({ chainId: 1, webhookId: "wh_eth", signingKeyCiphertext: "k", webhookUrl: "u", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });

    h.fakeClient.nextError = "alchemy returned 500";

    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 2_000,
      maxAttempts: 3
    });
    const result = await sweep();

    expect(result.failedChains).toBe(1);
    const rows = await h.subscriptionStore.findByAddress(1, "0xa");
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastError).toContain("alchemy returned 500");
  });

  it("flips rows to 'failed' after maxAttempts failures (no infinite retry)", async () => {
    await h.registryStore.upsert({ chainId: 1, webhookId: "wh_eth", signingKeyCiphertext: "k", webhookUrl: "u", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });

    let elapsed = 0;
    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 1_000_000 + elapsed,
      maxAttempts: 3,
      retryBackoffMs: 0 // run sweeps back-to-back for the test
    });

    h.fakeClient.nextError = "fail-1";
    await sweep();
    elapsed += 1;
    h.fakeClient.nextError = "fail-2";
    await sweep();
    elapsed += 1;
    h.fakeClient.nextError = "fail-3";
    await sweep();

    const rows = await h.subscriptionStore.findByAddress(1, "0xa");
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.attempts).toBe(3);

    // Next sweep should not claim the 'failed' row again.
    await sweep();
    expect(h.fakeClient.calls).toHaveLength(3);
  });

  it("dedupes repeated adds of the same address in a single batch", async () => {
    await h.registryStore.upsert({ chainId: 1, webhookId: "wh_eth", signingKeyCiphertext: "k", webhookUrl: "u", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });
    await h.subscriptionStore.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });

    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger(),
      now: () => 2_000
    });
    await sweep();

    expect(h.fakeClient.calls[0]?.addressesToAdd).toEqual(["0xa"]);
  });

  it("no-ops cleanly when nothing is pending", async () => {
    const sweep = makeAlchemySyncSweep({
      adminClient: h.fakeClient.client,
      registryStore: h.registryStore,
      subscriptionStore: h.subscriptionStore,
      logger: bufferingLogger()
    });
    const result = await sweep();
    expect(result).toEqual({ claimed: 0, syncedChains: 0, skippedChains: 0, failedChains: 0, byChain: [] });
    expect(h.fakeClient.calls).toHaveLength(0);
  });
});
