import { beforeEach, describe, expect, it } from "vitest";
import { libsqlAdapter } from "../../adapters/db/libsql.adapter.js";
import { loadMigrationsFromDir } from "../../adapters/db/fs-migration-loader.js";
import { applyMigrations } from "../../adapters/db/migration-runner.js";
import {
  dbAlchemyRegistryStore,
  type AlchemyRegistryStore
} from "../../adapters/detection/alchemy-registry-store.js";

// Each test gets its own :memory: DB + schema so rows don't bleed between cases.
async function freshStore(): Promise<AlchemyRegistryStore> {
  const db = libsqlAdapter({ url: ":memory:" });
  const migrationsDir = new URL("../../../migrations/", import.meta.url);
  await applyMigrations(db, loadMigrationsFromDir(migrationsDir));
  return dbAlchemyRegistryStore(db);
}

describe("dbAlchemyRegistryStore", () => {
  let store: AlchemyRegistryStore;

  beforeEach(async () => {
    store = await freshStore();
  });

  it("returns null for unknown webhookId and chainId", async () => {
    expect(await store.findByWebhookId("wh_does_not_exist")).toBeNull();
    expect(await store.findByChainId(999)).toBeNull();
  });

  it("upserts and then finds by both keys", async () => {
    const now = 1_700_000_000_000;
    await store.upsert({
      chainId: 1,
      webhookId: "wh_eth_mainnet",
      signingKeyCiphertext: "whsec_abc",
      webhookUrl: "https://gw.example.com/webhooks/alchemy",
      now
    });

    const byId = await store.findByWebhookId("wh_eth_mainnet");
    expect(byId).not.toBeNull();
    expect(byId).toMatchObject({
      chainId: 1,
      webhookId: "wh_eth_mainnet",
      signingKeyCiphertext: "whsec_abc",
      webhookUrl: "https://gw.example.com/webhooks/alchemy"
    });
    expect(byId!.createdAt.getTime()).toBe(now);

    const byChain = await store.findByChainId(1);
    expect(byChain?.webhookId).toBe("wh_eth_mainnet");
  });

  it("upsert on an existing chainId rotates the webhookId + signing key", async () => {
    await store.upsert({
      chainId: 1,
      webhookId: "wh_old",
      signingKeyCiphertext: "whsec_old",
      webhookUrl: "https://gw.example.com/webhooks/alchemy",
      now: 1_000
    });
    await store.upsert({
      chainId: 1,
      webhookId: "wh_new",
      signingKeyCiphertext: "whsec_new",
      webhookUrl: "https://gw.example.com/webhooks/alchemy",
      now: 2_000
    });
    // The old webhookId lookup returns null now — the replacement is canonical.
    expect(await store.findByWebhookId("wh_old")).toBeNull();
    const fresh = await store.findByWebhookId("wh_new");
    expect(fresh?.signingKeyCiphertext).toBe("whsec_new");
    expect(fresh?.updatedAt.getTime()).toBe(2_000);
  });

  it("list returns every row ordered by chain_id", async () => {
    await store.upsert({
      chainId: 137,
      webhookId: "wh_polygon",
      signingKeyCiphertext: "k137",
      webhookUrl: "u",
      now: 1_000
    });
    await store.upsert({ chainId: 1, webhookId: "wh_eth", signingKeyCiphertext: "k1", webhookUrl: "u", now: 1_000 });
    await store.upsert({
      chainId: 8453,
      webhookId: "wh_base",
      signingKeyCiphertext: "k8453",
      webhookUrl: "u",
      now: 1_000
    });

    const all = await store.list();
    expect(all.map((r) => r.chainId)).toEqual([1, 137, 8453]);
  });

  it("rejects a duplicate webhookId on a different chainId (UNIQUE constraint)", async () => {
    await store.upsert({
      chainId: 1,
      webhookId: "wh_dupe",
      signingKeyCiphertext: "k",
      webhookUrl: "u",
      now: 1_000
    });
    // Another chain trying to claim the same Alchemy webhook id: UNIQUE fires.
    await expect(
      store.upsert({ chainId: 137, webhookId: "wh_dupe", signingKeyCiphertext: "k2", webhookUrl: "u", now: 2_000 })
    ).rejects.toThrow(/UNIQUE|webhook_id/i);
  });
});
