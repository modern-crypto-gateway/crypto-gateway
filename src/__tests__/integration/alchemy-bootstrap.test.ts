import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { alchemyWebhookRegistry } from "../../db/schema.js";
import type {
  AlchemyAdminClient,
  AlchemyWebhookSummary
} from "../../adapters/detection/alchemy-admin-client.js";
import { adminRouter } from "../../http/routes/admin.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const ADMIN_KEY = "super-secret-admin-key-that-is-at-least-32-chars";

// Build a Hono app with the admin router mounted + a fake Alchemy admin client
// injected via the router's options. Reuses everything else from bootTestApp.
function mountAdminWith(booted: BootedTestApp, factory: (authToken: string) => AlchemyAdminClient): Hono {
  const app = new Hono();
  app.route("/admin", adminRouter(booted.deps, { alchemyAdminClientFactory: factory }));
  return app;
}

function fakeClient(overrides: {
  listWebhooks?: () => Promise<readonly AlchemyWebhookSummary[]>;
  createWebhook?: (args: Parameters<AlchemyAdminClient["createWebhook"]>[0]) => Promise<AlchemyWebhookSummary>;
  updateWebhookAddresses?: (args: Parameters<AlchemyAdminClient["updateWebhookAddresses"]>[0]) => Promise<void>;
}): AlchemyAdminClient {
  return {
    listWebhooks: overrides.listWebhooks ?? (async () => []),
    createWebhook:
      overrides.createWebhook ??
      (async () => {
        throw new Error("unexpected createWebhook call");
      }),
    // Bootstrap calls this after every create+existing (removes the seed
    // placeholder). Default is a silent no-op so tests that don't care about
    // the remove path don't have to stub it. Override when you want to
    // assert the call happened.
    updateWebhookAddresses: overrides.updateWebhookAddresses ?? (async () => undefined)
  };
}

function authHeader(token = ADMIN_KEY): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

describe("POST /admin/bootstrap/alchemy-webhooks", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({
      secretsOverrides: {
        ADMIN_KEY,
        ALCHEMY_NOTIFY_TOKEN: "notify_test",
        GATEWAY_PUBLIC_URL: "https://gateway.example.com"
      }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("400 when ALCHEMY_NOTIFY_TOKEN is not set (endpoint needs it)", async () => {
    const noToken = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
    try {
      const app = mountAdminWith(noToken, () => fakeClient({}));
      const res = await app.fetch(
        new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
          method: "POST",
          headers: authHeader(),
          body: "{}"
        })
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_CONFIGURED");
    } finally {
      await noToken.close();
    }
  });

  it("400 when GATEWAY_PUBLIC_URL env is not set", async () => {
    const noUrl = await bootTestApp({
      secretsOverrides: { ADMIN_KEY, ALCHEMY_NOTIFY_TOKEN: "notify_test" }
    });
    try {
      const app = mountAdminWith(noUrl, () => fakeClient({}));
      const res = await app.fetch(
        new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
          method: "POST",
          headers: authHeader(),
          body: "{}"
        })
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("MISSING_GATEWAY_PUBLIC_URL");
    } finally {
      await noUrl.close();
    }
  });

  it("401 without admin key (admin auth still gates this route)", async () => {
    const app = mountAdminWith(booted, () => fakeClient({}));
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(res.status).toBe(401);
  });

  it("happy path: creates missing webhooks and returns signing keys", async () => {
    const app = mountAdminWith(booted, (_authToken) =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => ({
          id: `wh_${args.chainId}`,
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}`
        })
      })
    );
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1, 137] })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ chainId: number; status: string; webhookId?: string; signingKey?: string; persisted?: boolean }>;
    };
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(body.results[0]?.signingKey).toBe("whsec_1");
    expect(body.results[1]?.signingKey).toBe("whsec_137");

    // Every created row is persisted in the registry so the inbound ingest
    // route can resolve signing keys by webhookId.
    expect(body.results.every((r) => r.persisted === true)).toBe(true);
    const rows = await booted.deps.db
      .select({
        chain_id: alchemyWebhookRegistry.chainId,
        webhook_id: alchemyWebhookRegistry.webhookId,
        signing_key_ciphertext: alchemyWebhookRegistry.signingKeyCiphertext
      })
      .from(alchemyWebhookRegistry)
      .orderBy(asc(alchemyWebhookRegistry.chainId));
    expect(rows.map((r) => ({ chain_id: r.chain_id, webhook_id: r.webhook_id }))).toEqual([
      { chain_id: 1, webhook_id: "wh_1" },
      { chain_id: 137, webhook_id: "wh_137" }
    ]);
    // Stored signing keys are ciphertext, not plaintext — the security fix.
    for (const r of rows) {
      expect(r.signing_key_ciphertext).toMatch(/^v1:/);
      expect(r.signing_key_ciphertext).not.toContain("whsec_");
    }
    // Round-trip: decrypted ciphertext matches what Alchemy returned.
    const decrypted1 = await booted.deps.secretsCipher.decrypt(rows[0]!.signing_key_ciphertext);
    const decrypted137 = await booted.deps.secretsCipher.decrypt(rows[1]!.signing_key_ciphertext);
    expect(decrypted1).toBe("whsec_1");
    expect(decrypted137).toBe("whsec_137");
  });

  it("re-bootstrapping with new signing keys rotates the DB row", async () => {
    let version = 1;
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => ({
          id: `wh_${args.chainId}_v${version}`,
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}_v${version}`
        })
      })
    );
    await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1] })
      })
    );

    // Simulate a dashboard-driven delete + recreate: second run produces a
    // different webhookId + signing key and the registry should reflect that.
    version = 2;
    await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1] })
      })
    );

    const [row] = await booted.deps.db
      .select({
        webhook_id: alchemyWebhookRegistry.webhookId,
        signing_key_ciphertext: alchemyWebhookRegistry.signingKeyCiphertext
      })
      .from(alchemyWebhookRegistry)
      .where(eq(alchemyWebhookRegistry.chainId, 1))
      .limit(1);
    expect(row?.webhook_id).toBe("wh_1_v2");
    // Ciphertext rotated too — decrypting yields the new plaintext from v2.
    const decrypted = await booted.deps.secretsCipher.decrypt(row!.signing_key_ciphertext);
    expect(decrypted).toBe("whsec_1_v2");
  });

  it("idempotent: re-running with the same URL reports 'existing' without creating again", async () => {
    let createCalls = 0;
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [
          {
            id: "wh_existing",
            network: "ETH_MAINNET",
            webhook_type: "ADDRESS_ACTIVITY",
            webhook_url: "https://gateway.example.com/webhooks/alchemy",
            is_active: true
          }
        ],
        createWebhook: async (args) => {
          createCalls += 1;
          return {
            id: `wh_${args.chainId}`,
            network: "ETH_MAINNET",
            webhook_type: "ADDRESS_ACTIVITY",
            webhook_url: args.webhookUrl,
            is_active: true,
            signing_key: `whsec_${args.chainId}`
          };
        }
      })
    );
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1] })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ status: string }> };
    expect(body.results[0]?.status).toBe("existing");
    expect(createCalls).toBe(0);
  });

  it("ignores body.webhookUrl — env-only gating prevents ADMIN_KEY-leak escalation", async () => {
    // Security regression: a prior version let the caller specify webhookUrl
    // in the body. That turned a leaked ADMIN_KEY into an arbitrary-redirect
    // primitive against Alchemy. The handler now sources the URL from
    // GATEWAY_PUBLIC_URL env exclusively and silently drops the body field.
    const seenWebhookUrls: string[] = [];
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => {
          seenWebhookUrls.push(args.webhookUrl);
          return {
            id: `wh_${args.chainId}`,
            network: "ETH_MAINNET",
            webhook_type: "ADDRESS_ACTIVITY",
            webhook_url: args.webhookUrl,
            is_active: true,
            signing_key: `whsec_${args.chainId}`
          };
        }
      })
    );
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({
          chainIds: [1],
          webhookUrl: "https://evil.example.com/exfil"
        })
      })
    );
    expect(res.status).toBe(200);
    expect(seenWebhookUrls).toEqual(["https://gateway.example.com/webhooks/alchemy"]);
  });

  it("flags unsupported chainIds without creating a webhook for them", async () => {
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => ({
          id: `wh_${args.chainId}`,
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}`
        })
      })
    );
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [99999, 1] })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ chainId: number; status: string }> };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ chainId: 99999, status: "unsupported" });
    expect(body.results[1]).toMatchObject({ chainId: 1, status: "created" });
  });

  it("uses per-family placeholder seed: base58 all-zeros for Solana (chain 900)", async () => {
    // Regression guard: passing the EVM zero address to Solana's create-webhook
    // produces `"Must be a valid solana address, base58..."` — the exact error
    // that blew up in prod. Bootstrap must route by family.
    const createCalls: Array<{ chainId: number; addresses: readonly string[]; name?: string }> = [];
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => {
          const entry: { chainId: number; addresses: readonly string[]; name?: string } = {
            chainId: args.chainId,
            addresses: args.addresses
          };
          if (args.name !== undefined) entry.name = args.name;
          createCalls.push(entry);
          return {
            id: `wh_${args.chainId}`,
            network: args.chainId === 900 ? "SOLANA_MAINNET" : "ETH_MAINNET",
            webhook_type: "ADDRESS_ACTIVITY",
            webhook_url: args.webhookUrl,
            is_active: true,
            signing_key: `whsec_${args.chainId}`
          };
        }
      })
    );
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1, 900] })
      })
    );
    expect(res.status).toBe(200);
    const evm = createCalls.find((c) => c.chainId === 1);
    const sol = createCalls.find((c) => c.chainId === 900);
    expect(evm?.addresses).toEqual(["0x0000000000000000000000000000000000000000"]);
    // Solana placeholder is a deterministically-derived ed25519 pubkey.
    // Exact value is validated separately; here we just check it's a valid
    // base58 Solana address (32-44 chars, no 0OIl) and NOT a program address
    // (Alchemy blocklists those).
    const solSeed = sol?.addresses[0] ?? "";
    expect(solSeed).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(solSeed).not.toBe("11111111111111111111111111111111");
    // Names are passed so the dashboard doesn't show unlabelled rows.
    expect(evm?.name).toBe("crypto-gateway evm-1");
    expect(sol?.name).toBe("crypto-gateway solana-900");
  });

  it("removes the placeholder from the watch list immediately after create (no mint/burn flood)", async () => {
    const removeCalls: Array<{ webhookId: string; addressesToRemove?: readonly string[] }> = [];
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => ({
          id: `wh_${args.chainId}`,
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}`
        }),
        updateWebhookAddresses: async (args) => {
          removeCalls.push({
            webhookId: args.webhookId,
            ...(args.addressesToRemove !== undefined ? { addressesToRemove: args.addressesToRemove } : {})
          });
        }
      })
    );
    await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1] })
      })
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]?.webhookId).toBe("wh_1");
    expect(removeCalls[0]?.addressesToRemove).toEqual([
      "0x0000000000000000000000000000000000000000"
    ]);
  });

  it("preserves operator-supplied seedAddressByChainId (keeps it watched, no remove call)", async () => {
    const operatorSeed = "0xABCDabcdABCDabcdABCDabcdABCDabcdABCDabcd";
    let removeCalls = 0;
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => ({
          id: `wh_${args.chainId}`,
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}`
        }),
        updateWebhookAddresses: async () => {
          removeCalls += 1;
        }
      })
    );
    await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({
          chainIds: [1],
          seedAddressByChainId: { "1": operatorSeed }
        })
      })
    );
    // Operator asked for this address to be watched — keep it.
    expect(removeCalls).toBe(0);
  });

  it("self-heals: removes the placeholder from EXISTING webhooks so re-running bootstrap cleans up an earlier bad seed", async () => {
    const removeCalls: Array<{ webhookId: string; addressesToRemove?: readonly string[] }> = [];
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [
          {
            id: "wh_preexisting",
            network: "ETH_MAINNET",
            webhook_type: "ADDRESS_ACTIVITY",
            webhook_url: "https://gateway.example.com/webhooks/alchemy",
            is_active: true
          }
        ],
        updateWebhookAddresses: async (args) => {
          removeCalls.push({
            webhookId: args.webhookId,
            ...(args.addressesToRemove !== undefined ? { addressesToRemove: args.addressesToRemove } : {})
          });
        }
      })
    );
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1] })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ status: string; placeholderRemoved?: boolean }> };
    expect(body.results[0]?.status).toBe("existing");
    expect(body.results[0]?.placeholderRemoved).toBe(true);
    expect(removeCalls).toEqual([
      {
        webhookId: "wh_preexisting",
        addressesToRemove: ["0x0000000000000000000000000000000000000000"]
      }
    ]);
  });

  it("does NOT fail bootstrap if the placeholder-remove call errors (best-effort cleanup)", async () => {
    const app = mountAdminWith(booted, () =>
      fakeClient({
        listWebhooks: async () => [],
        createWebhook: async (args) => ({
          id: `wh_${args.chainId}`,
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: args.webhookUrl,
          is_active: true,
          signing_key: `whsec_${args.chainId}`
        }),
        updateWebhookAddresses: async () => {
          throw new Error("Alchemy transient 503");
        }
      })
    );
    const res = await app.fetch(
      new Request("http://test.local/admin/bootstrap/alchemy-webhooks", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ chainIds: [1] })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ status: string; placeholderRemoved?: boolean }> };
    expect(body.results[0]?.status).toBe("created");
    expect(body.results[0]?.placeholderRemoved).toBe(false);
  });
});
