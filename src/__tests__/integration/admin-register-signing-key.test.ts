import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { alchemyWebhookRegistry } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

// Shared ADMIN_KEY for this suite — ≥32 chars to match prod refinement rules,
// even though test runs default to NODE_ENV=test.
const ADMIN_KEY = "super-secret-admin-key-that-is-at-least-32-chars";

function authHeader(token = ADMIN_KEY): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function register(booted: BootedTestApp, body: unknown, token = ADMIN_KEY): Promise<Response> {
  return booted.app.fetch(
    new Request("http://test.local/admin/alchemy-webhooks/signing-keys", {
      method: "POST",
      headers: authHeader(token),
      body: typeof body === "string" ? body : JSON.stringify(body)
    })
  );
}

describe("POST /admin/alchemy-webhooks/signing-keys", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("401 without an admin key", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/alchemy-webhooks/signing-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(res.status).toBe(401);
  });

  it("400 on malformed JSON", async () => {
    const res = await register(booted, "not-json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_JSON");
  });

  it("400 on missing required fields", async () => {
    const res = await register(booted, { chainId: 1 });
    expect(res.status).toBe(400);
  });

  it("persists the signing key as ciphertext + round-trips through secretsCipher", async () => {
    const res = await register(booted, {
      chainId: 1,
      webhookId: "wh_manual_test",
      signingKey: "whsec_manual_test",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { registered: { chainId: number; webhookId: string; webhookUrl: string } };
    expect(body.registered).toEqual({
      chainId: 1,
      webhookId: "wh_manual_test",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });

    // Pull the DB row directly — the stored column is ciphertext, not plaintext.
    const [row] = await booted.deps.db
      .select({
        chain_id: alchemyWebhookRegistry.chainId,
        webhook_id: alchemyWebhookRegistry.webhookId,
        signing_key_ciphertext: alchemyWebhookRegistry.signingKeyCiphertext
      })
      .from(alchemyWebhookRegistry)
      .where(eq(alchemyWebhookRegistry.webhookId, "wh_manual_test"))
      .limit(1);
    expect(row?.chain_id).toBe(1);
    expect(row?.signing_key_ciphertext).toMatch(/^v1:/);
    expect(row?.signing_key_ciphertext).not.toContain("whsec_manual_test");

    // Decrypt to confirm the original plaintext survived the round-trip.
    const decrypted = await booted.deps.secretsCipher.decrypt(row!.signing_key_ciphertext);
    expect(decrypted).toBe("whsec_manual_test");
  });

  it("upserts — re-registering with the same chainId rotates webhookId + signing key", async () => {
    await register(booted, {
      chainId: 1,
      webhookId: "wh_old",
      signingKey: "whsec_old",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });
    const res = await register(booted, {
      chainId: 1,
      webhookId: "wh_new",
      signingKey: "whsec_new",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });
    expect(res.status).toBe(201);

    // Only one row per chainId (upsert on chain_id primary key).
    const rows = await booted.deps.db
      .select({
        webhook_id: alchemyWebhookRegistry.webhookId,
        signing_key_ciphertext: alchemyWebhookRegistry.signingKeyCiphertext
      })
      .from(alchemyWebhookRegistry)
      .where(eq(alchemyWebhookRegistry.chainId, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.webhook_id).toBe("wh_new");
    const decrypted = await booted.deps.secretsCipher.decrypt(rows[0]!.signing_key_ciphertext);
    expect(decrypted).toBe("whsec_new");
  });

  it("401 with a wrong admin key", async () => {
    const res = await register(
      booted,
      {
        chainId: 1,
        webhookId: "wh_x",
        signingKey: "whsec_x",
        webhookUrl: "https://gateway.example.com/webhooks/alchemy"
      },
      "definitely-wrong"
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/alchemy-webhooks", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function listWebhooks(query = "", token = ADMIN_KEY): Promise<Response> {
    return booted.app.fetch(
      new Request(`http://test.local/admin/alchemy-webhooks${query}`, {
        headers: { authorization: `Bearer ${token}` }
      })
    );
  }

  it("401 without an admin key", async () => {
    const res = await booted.app.fetch(new Request("http://test.local/admin/alchemy-webhooks"));
    expect(res.status).toBe(401);
  });

  it("returns one row per registered chain, signing key never present", async () => {
    await register(booted, {
      chainId: 1,
      webhookId: "wh_eth",
      signingKey: "whsec_eth_secret",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });
    await register(booted, {
      chainId: 137,
      webhookId: "wh_polygon",
      signingKey: "whsec_polygon_secret",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });

    const res = await listWebhooks();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      webhooks: Array<Record<string, unknown>>;
      hasMore: boolean;
    };
    expect(body.webhooks).toHaveLength(2);
    expect(body.hasMore).toBe(false);
    const chainIds = body.webhooks.map((w) => w["chainId"]);
    expect(chainIds).toEqual([1, 137]);
    // Signing key (or its ciphertext) must never appear in the response.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("whsec_");
    expect(serialized).not.toContain("signing");
    expect(body.webhooks[0]).toMatchObject({
      chainId: 1,
      webhookId: "wh_eth",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy",
      chain: "ethereum"
    });
  });

  it("filters by chainId", async () => {
    await register(booted, {
      chainId: 1,
      webhookId: "wh_eth",
      signingKey: "whsec_eth",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });
    await register(booted, {
      chainId: 137,
      webhookId: "wh_polygon",
      signingKey: "whsec_polygon",
      webhookUrl: "https://gateway.example.com/webhooks/alchemy"
    });

    const res = await listWebhooks("?chainId=137");
    const body = (await res.json()) as { webhooks: Array<{ chainId: number }> };
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]?.chainId).toBe(137);
  });

  it("400 on a non-numeric chainId", async () => {
    const res = await listWebhooks("?chainId=abc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_CHAIN_ID");
  });

  it("returns an empty list when nothing is registered", async () => {
    const res = await listWebhooks();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: unknown[]; hasMore: boolean };
    expect(body.webhooks).toEqual([]);
    expect(body.hasMore).toBe(false);
  });
});
