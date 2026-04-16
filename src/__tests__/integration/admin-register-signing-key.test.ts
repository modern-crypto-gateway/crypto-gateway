import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const row = await booted.deps.db
      .prepare(
        "SELECT chain_id, webhook_id, signing_key_ciphertext FROM alchemy_webhook_registry WHERE webhook_id = ?"
      )
      .bind("wh_manual_test")
      .first<{ chain_id: number; webhook_id: string; signing_key_ciphertext: string }>();
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
      .prepare("SELECT webhook_id, signing_key_ciphertext FROM alchemy_webhook_registry WHERE chain_id = 1")
      .all<{ webhook_id: string; signing_key_ciphertext: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.webhook_id).toBe("wh_new");
    const decrypted = await booted.deps.secretsCipher.decrypt(rows.results[0]!.signing_key_ciphertext);
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
