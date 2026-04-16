import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { libsqlAdapter } from "../../adapters/db/libsql.adapter.js";
import {
  dbAlchemyRegistryStore,
  type AlchemyRegistryStore
} from "../../adapters/detection/alchemy-registry-store.js";

// Each test gets its own :memory: DB + schema so rows don't bleed between cases.
async function freshStore(): Promise<AlchemyRegistryStore> {
  const db = libsqlAdapter({ url: ":memory:" });
  const here = dirname(fileURLToPath(import.meta.url));
  // src/__tests__/unit/... -> repo root is three dirs up.
  const schemaPath = resolve(here, "..", "..", "..", "migrations", "schema.sql");
  await db.exec(readFileSync(schemaPath, "utf8"));
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
      signingKey: "whsec_abc",
      webhookUrl: "https://gw.example.com/webhooks/alchemy",
      now
    });

    const byId = await store.findByWebhookId("wh_eth_mainnet");
    expect(byId).not.toBeNull();
    expect(byId).toMatchObject({
      chainId: 1,
      webhookId: "wh_eth_mainnet",
      signingKey: "whsec_abc",
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
      signingKey: "whsec_old",
      webhookUrl: "https://gw.example.com/webhooks/alchemy",
      now: 1_000
    });
    await store.upsert({
      chainId: 1,
      webhookId: "wh_new",
      signingKey: "whsec_new",
      webhookUrl: "https://gw.example.com/webhooks/alchemy",
      now: 2_000
    });
    // The old webhookId lookup returns null now — the replacement is canonical.
    expect(await store.findByWebhookId("wh_old")).toBeNull();
    const fresh = await store.findByWebhookId("wh_new");
    expect(fresh?.signingKey).toBe("whsec_new");
    expect(fresh?.updatedAt.getTime()).toBe(2_000);
  });

  it("list returns every row ordered by chain_id", async () => {
    await store.upsert({
      chainId: 137,
      webhookId: "wh_polygon",
      signingKey: "k137",
      webhookUrl: "u",
      now: 1_000
    });
    await store.upsert({ chainId: 1, webhookId: "wh_eth", signingKey: "k1", webhookUrl: "u", now: 1_000 });
    await store.upsert({
      chainId: 8453,
      webhookId: "wh_base",
      signingKey: "k8453",
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
      signingKey: "k",
      webhookUrl: "u",
      now: 1_000
    });
    // Another chain trying to claim the same Alchemy webhook id: UNIQUE fires.
    await expect(
      store.upsert({ chainId: 137, webhookId: "wh_dupe", signingKey: "k2", webhookUrl: "u", now: 2_000 })
    ).rejects.toThrow(/UNIQUE|webhook_id/i);
  });
});
