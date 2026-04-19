import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feeWallets } from "../../db/schema.js";
import { feeWalletIndex } from "../../adapters/signer-store/hd.adapter.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const ADMIN_KEY = "super-secret-admin-key";
const TEST_MASTER_SEED = "test test test test test test test test test test test junk";

describe("POST /admin/merchants", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("creates a merchant and returns the plaintext API key exactly once", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ name: "Acme Corp" })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { merchant: { id: string; name: string }; apiKey: string };
    expect(body.merchant.name).toBe("Acme Corp");
    expect(body.merchant.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.apiKey).toMatch(/^sk_[0-9a-f]{64}$/);

    // The returned plaintext must successfully authenticate on /api/v1/invoices.
    const invoiceRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${body.apiKey}` },
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(invoiceRes.status).toBe(201);
  });

  it("rejects admin requests without the admin key (401)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nope" })
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects admin requests with a wrong admin key (401)", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
        body: JSON.stringify({ name: "Nope" })
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when ADMIN_KEY is not configured (admin surface disabled)", async () => {
    const noAdmin = await bootTestApp({});
    try {
      const res = await noAdmin.app.fetch(
        new Request("http://test.local/admin/merchants", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer anything" },
          body: JSON.stringify({ name: "Nope" })
        })
      );
      expect(res.status).toBe(404);
    } finally {
      await noAdmin.close();
    }
  });

  it("also returns and echoes the webhook secret when webhookUrl is set", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ name: "Hooked", webhookUrl: "https://merchant.test/hook" })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { apiKey: string; webhookSecret?: string };
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("POST /admin/fee-wallets", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("registers a fee wallet by deriving its address from MASTER_SEED and label", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ chainId: 999, label: "hot-1", family: "evm" })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { feeWallet: { address: string; label: string } };

    // The returned address must match what the adapter derives at the
    // deterministic fee-wallet index for (family, label).
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const { address: expectedAddress, privateKey: expectedPrivateKey } = adapter.deriveAddress(
      TEST_MASTER_SEED,
      feeWalletIndex("evm", "hot-1")
    );
    const canonicalExpected = adapter.canonicalizeAddress(expectedAddress);
    expect(body.feeWallet.address).toBe(canonicalExpected);

    const [walletRow] = await booted.deps.db
      .select({ address: feeWallets.address, label: feeWallets.label })
      .from(feeWallets)
      .limit(1);
    expect(walletRow?.label).toBe("hot-1");
    expect(walletRow?.address).toBe(canonicalExpected);

    // SignerStore.get returns the matching private key derived from the same
    // seed+index — no put() was ever called, and none is needed.
    const storedKey = await booted.deps.signerStore.get({ kind: "fee-wallet", family: "evm", label: "hot-1" });
    expect(storedKey).toBe(expectedPrivateKey);
  });

  it("rejects a family that doesn't match the chain adapter", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({
          chainId: 999, // dev adapter declares family="evm"
          label: "broken",
          family: "tron"
        })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FAMILY_MISMATCH");
  });
});

async function createMerchant(
  booted: BootedTestApp,
  body: Record<string, unknown> = { name: "Acme" }
): Promise<{ id: string; apiKey: string }> {
  const res = await booted.app.fetch(
    new Request("http://test.local/admin/merchants", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify(body)
    })
  );
  const parsed = (await res.json()) as { merchant: { id: string }; apiKey: string };
  return { id: parsed.merchant.id, apiKey: parsed.apiKey };
}

describe("GET /admin/merchants", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("lists created merchants without leaking secrets", async () => {
    const first = await createMerchant(booted, { name: "First" });
    const second = await createMerchant(booted, { name: "Second" });

    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchants: ReadonlyArray<{ id: string; name: string; active: boolean }>;
      limit: number;
      offset: number;
    };
    // bootTestApp seeds a default "Test Merchant" before our two → 3 rows.
    const ids = body.merchants.map((m) => m.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(body.merchants.every((m) => m.active)).toBe(true);
    // No secret fields leaked.
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/apiKeyHash|webhookSecret|ciphertext/i);
  });

  it("filters by active status", async () => {
    const m1 = await createMerchant(booted, { name: "Kept" });
    const m2 = await createMerchant(booted, { name: "Gone" });
    // deactivate m2
    await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${m2.id}/deactivate`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );

    const activeRes = await booted.app.fetch(
      new Request("http://test.local/admin/merchants?active=true", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    const activeBody = (await activeRes.json()) as {
      merchants: ReadonlyArray<{ id: string }>;
    };
    const activeIds = activeBody.merchants.map((m) => m.id);
    expect(activeIds).toContain(m1.id);
    expect(activeIds).not.toContain(m2.id);

    const inactiveRes = await booted.app.fetch(
      new Request("http://test.local/admin/merchants?active=false", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    const inactiveBody = (await inactiveRes.json()) as {
      merchants: ReadonlyArray<{ id: string }>;
    };
    expect(inactiveBody.merchants.map((m) => m.id)).toEqual([m2.id]);
  });

  it("rejects invalid ?active values", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants?active=maybe", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/merchants/:id", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("returns the merchant by id", async () => {
    const created = await createMerchant(booted, { name: "Solo" });
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${created.id}`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchant: { id: string; name: string; active: boolean } };
    expect(body.merchant.id).toBe(created.id);
    expect(body.merchant.name).toBe("Solo");
    expect(body.merchant.active).toBe(true);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants/00000000-0000-0000-0000-000000000000", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/merchants/:id", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("updates name", async () => {
    const { id } = await createMerchant(booted, { name: "Original" });
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ name: "Renamed" })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchant: { name: string } };
    expect(body.merchant.name).toBe("Renamed");
  });

  it("sets webhookUrl on a merchant created without one and mints a secret", async () => {
    const { id } = await createMerchant(booted, { name: "NoHook" });
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ webhookUrl: "https://merchant.test/hook" })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchant: { webhookUrl: string | null };
      webhookSecret?: string;
    };
    expect(body.merchant.webhookUrl).toBe("https://merchant.test/hook");
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changing webhookUrl on a merchant that already had one does NOT mint a new secret", async () => {
    const { id } = await createMerchant(booted, {
      name: "Hooked",
      webhookUrl: "https://old.test/hook"
    });
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ webhookUrl: "https://new.test/hook" })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchant: { webhookUrl: string | null };
      webhookSecret?: string;
    };
    expect(body.merchant.webhookUrl).toBe("https://new.test/hook");
    expect(body.webhookSecret).toBeUndefined();
  });

  it("rejects an SSRF-unsafe webhookUrl", async () => {
    const { id } = await createMerchant(booted, { name: "AboutToFail" });
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ webhookUrl: "http://169.254.169.254/latest/meta-data/" })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("rejects empty body (no updatable fields)", async () => {
    const { id } = await createMerchant(booted, { name: "Stable" });
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({})
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/merchants/:id/rotate-webhook-secret", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("rotates the secret and returns the new plaintext once", async () => {
    // Create with a webhookUrl so a secret exists to rotate.
    const createRes = await booted.app.fetch(
      new Request("http://test.local/admin/merchants", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ name: "Hooked", webhookUrl: "https://merchant.test/hook" })
      })
    );
    const createBody = (await createRes.json()) as {
      merchant: { id: string };
      webhookSecret: string;
    };
    const oldSecret = createBody.webhookSecret;
    expect(oldSecret).toMatch(/^[0-9a-f]{64}$/);

    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${createBody.merchant.id}/rotate-webhook-secret`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhookSecret: string; merchant: { webhookUrl: string | null } };
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.webhookSecret).not.toBe(oldSecret);
    expect(body.merchant.webhookUrl).toBe("https://merchant.test/hook");
  });

  it("returns 400 when the merchant has no webhookUrl", async () => {
    const { id } = await createMerchant(booted, { name: "NoHook" });
    const res = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}/rotate-webhook-secret`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NO_WEBHOOK_URL");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants/00000000-0000-0000-0000-000000000000/rotate-webhook-secret", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/merchants/:id/rotate-key", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("issues a new plaintext key, old key stops working, new key works", async () => {
    const { id, apiKey: oldKey } = await createMerchant(booted);

    // old key works pre-rotation
    const preRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${oldKey}` },
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(preRes.status).toBe(201);

    const rotateRes = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}/rotate-key`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(rotateRes.status).toBe(200);
    const rotateBody = (await rotateRes.json()) as { apiKey: string };
    expect(rotateBody.apiKey).toMatch(/^sk_[0-9a-f]{64}$/);
    expect(rotateBody.apiKey).not.toBe(oldKey);

    // old key rejected
    const postOldRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${oldKey}` },
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(postOldRes.status).toBe(401);

    // new key works
    const postNewRes = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${rotateBody.apiKey}` },
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(postNewRes.status).toBe(201);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants/00000000-0000-0000-0000-000000000000/rotate-key", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/merchants/:id/deactivate + /activate", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("deactivation blocks inbound API; reactivation restores access", async () => {
    const { id, apiKey } = await createMerchant(booted);

    const deact = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}/deactivate`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(deact.status).toBe(200);
    const deactBody = (await deact.json()) as { merchant: { active: boolean } };
    expect(deactBody.merchant.active).toBe(false);

    const blocked = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(blocked.status).toBe(401);

    const reactivate = await booted.app.fetch(
      new Request(`http://test.local/admin/merchants/${id}/activate`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(reactivate.status).toBe(200);
    const reactBody = (await reactivate.json()) as { merchant: { active: boolean } };
    expect(reactBody.merchant.active).toBe(true);

    // same key works again after reactivation — no rotation needed.
    const unblocked = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(unblocked.status).toBe(201);
  });

  it("deactivating an already-inactive merchant is idempotent", async () => {
    const { id } = await createMerchant(booted);
    for (let i = 0; i < 2; i++) {
      const res = await booted.app.fetch(
        new Request(`http://test.local/admin/merchants/${id}/deactivate`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_KEY}` }
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { merchant: { active: boolean } };
      expect(body.merchant.active).toBe(false);
    }
  });

  it("returns 404 for an unknown id", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/merchants/00000000-0000-0000-0000-000000000000/deactivate", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/fee-wallets", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("lists registered fee wallets with reservation state", async () => {
    await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ chainId: 999, label: "hot-1", family: "evm" })
      })
    );
    await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ chainId: 999, label: "hot-2", family: "evm" })
      })
    );

    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feeWallets: ReadonlyArray<{
        label: string;
        chainId: number;
        active: boolean;
        reservedByPayoutId: string | null;
        reservedAt: string | null;
      }>;
    };
    expect(body.feeWallets.length).toBe(2);
    expect(body.feeWallets.every((w) => w.active)).toBe(true);
    expect(body.feeWallets.every((w) => w.reservedByPayoutId === null)).toBe(true);
    expect(body.feeWallets.every((w) => w.reservedAt === null)).toBe(true);
    expect(new Set(body.feeWallets.map((w) => w.label))).toEqual(new Set(["hot-1", "hot-2"]));
  });

  it("filters by chainId, active, and reserved", async () => {
    await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ chainId: 999, label: "hot-1", family: "evm" })
      })
    );

    const byChain = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets?chainId=999", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(byChain.status).toBe(200);
    const byChainBody = (await byChain.json()) as {
      feeWallets: ReadonlyArray<{ chainId: number }>;
    };
    expect(byChainBody.feeWallets.length).toBe(1);

    const byOther = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets?chainId=1", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    const byOtherBody = (await byOther.json()) as { feeWallets: ReadonlyArray<unknown> };
    expect(byOtherBody.feeWallets.length).toBe(0);

    const byReserved = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets?reserved=true", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    const byReservedBody = (await byReserved.json()) as { feeWallets: ReadonlyArray<unknown> };
    expect(byReservedBody.feeWallets.length).toBe(0);
  });

  it("rejects invalid filter values", async () => {
    const badChain = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets?chainId=abc", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(badChain.status).toBe(400);
    const badActive = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets?active=maybe", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(badActive.status).toBe(400);
  });
});

describe("GET /admin/chains", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function listChains(query = ""): Promise<Response> {
    return booted.app.fetch(
      new Request(`http://test.local/admin/chains${query}`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
  }

  it("401 without an admin key", async () => {
    const res = await booted.app.fetch(new Request("http://test.local/admin/chains"));
    expect(res.status).toBe(401);
  });

  it("returns the static registry with wired flag and tokens", async () => {
    const res = await listChains();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chains: Array<{
        chainId: number;
        slug: string;
        family: string;
        wired: boolean;
        tokens: Array<{ symbol: string; decimals: number }>;
      }>;
    };
    // The dev chain (999) is wired by default in bootTestApp.
    const dev = body.chains.find((c) => c.chainId === 999);
    expect(dev).toBeDefined();
    expect(dev?.wired).toBe(true);
    expect(dev?.slug).toBe("dev");
    expect(dev?.tokens.find((t) => t.symbol === "DEV")).toMatchObject({ decimals: 6 });

    // Ethereum is in the registry but no adapter is wired in the test boot.
    const eth = body.chains.find((c) => c.chainId === 1);
    expect(eth).toBeDefined();
    expect(eth?.wired).toBe(false);
    expect(eth?.tokens.map((t) => t.symbol)).toEqual(expect.arrayContaining(["USDC", "USDT"]));
  });

  it("?wired=true narrows to wired adapters only", async () => {
    const res = await listChains("?wired=true");
    const body = (await res.json()) as { chains: Array<{ chainId: number; wired: boolean }> };
    expect(body.chains.length).toBeGreaterThan(0);
    expect(body.chains.every((c) => c.wired === true)).toBe(true);
    expect(body.chains.find((c) => c.chainId === 999)).toBeDefined();
    expect(body.chains.find((c) => c.chainId === 1)).toBeUndefined();
  });

  it("?family=evm narrows to one family", async () => {
    const res = await listChains("?family=evm");
    const body = (await res.json()) as { chains: Array<{ family: string }> };
    expect(body.chains.length).toBeGreaterThan(0);
    expect(body.chains.every((c) => c.family === "evm")).toBe(true);
  });

  it("400 on a bogus family", async () => {
    const res = await listChains("?family=bitcoin");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_FAMILY");
  });

  it("never leaks any signing or env material", async () => {
    const res = await listChains();
    const text = await res.text();
    expect(text).not.toMatch(/whsec_|signing|MASTER_SEED|privateKey|ADMIN_KEY/);
  });
});
