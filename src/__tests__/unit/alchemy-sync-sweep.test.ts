import { beforeEach, describe, expect, it } from "vitest";
import { libsqlAdapter } from "../../adapters/db/libsql.adapter.js";
import { loadMigrationsFromDir } from "../../adapters/db/fs-migration-loader.js";
import { applyMigrations } from "../../adapters/db/migration-runner.js";
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
  const db = libsqlAdapter({ url: ":memory:" });
  const migrationsDir = new URL("../../../migrations/", import.meta.url);
  await applyMigrations(db, loadMigrationsFromDir(migrationsDir));

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
