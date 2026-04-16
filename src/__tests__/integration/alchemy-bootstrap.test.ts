import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
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
    updateWebhookAddresses:
      overrides.updateWebhookAddresses ??
      (async () => {
        throw new Error("unexpected updateWebhookAddresses call");
      })
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
        ALCHEMY_AUTH_TOKEN: "alch_auth_test",
        ALCHEMY_WEBHOOK_URL: "https://gateway.example.com/webhooks/alchemy"
      }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("400 when ALCHEMY_AUTH_TOKEN is not set (endpoint needs it)", async () => {
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

  it("400 when neither body.webhookUrl nor ALCHEMY_WEBHOOK_URL is set", async () => {
    const noUrl = await bootTestApp({
      secretsOverrides: { ADMIN_KEY, ALCHEMY_AUTH_TOKEN: "alch_auth_test" }
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
      expect(body.error.code).toBe("MISSING_WEBHOOK_URL");
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
      .prepare("SELECT chain_id, webhook_id, signing_key FROM alchemy_webhook_registry ORDER BY chain_id")
      .all<{ chain_id: number; webhook_id: string; signing_key: string }>();
    expect(rows.results).toEqual([
      { chain_id: 1, webhook_id: "wh_1", signing_key: "whsec_1" },
      { chain_id: 137, webhook_id: "wh_137", signing_key: "whsec_137" }
    ]);
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

    const row = await booted.deps.db
      .prepare("SELECT webhook_id, signing_key FROM alchemy_webhook_registry WHERE chain_id = 1")
      .first<{ webhook_id: string; signing_key: string }>();
    expect(row).toEqual({ webhook_id: "wh_1_v2", signing_key: "whsec_1_v2" });
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
});
