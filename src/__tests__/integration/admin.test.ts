import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const ADMIN_KEY = "super-secret-admin-key";

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

  it("registers a fee wallet, canonicalizes the address, and stores the private key", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({
          chainId: 999,
          address: "0xAABBCCDDEEFF00112233445566778899AABBCCDD",
          label: "hot-1",
          privateKey: `0x${"11".repeat(32)}`,
          family: "evm"
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { feeWallet: { address: string; label: string } };
    // Dev adapter's canonical form is lowercase.
    expect(body.feeWallet.address).toBe("0xaabbccddeeff00112233445566778899aabbccdd");

    const walletRow = await booted.deps.db
      .prepare("SELECT address, label FROM fee_wallets")
      .first<{ address: string; label: string }>();
    expect(walletRow?.label).toBe("hot-1");

    // Key is accessible via the SignerStore at the expected scope.
    const storedKey = await booted.deps.signerStore.get({ kind: "fee-wallet", family: "evm", label: "hot-1" });
    expect(storedKey).toBe(`0x${"11".repeat(32)}`);
  });

  it("rejects a malformed address with 400", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({
          chainId: 999,
          address: "not-an-address",
          label: "broken",
          privateKey: "0x00",
          family: "evm"
        })
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a family that doesn't match the chain adapter", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({
          chainId: 999, // dev adapter declares family="evm"
          address: "0xAABBCCDDEEFF00112233445566778899AABBCCDD",
          label: "broken",
          privateKey: "0x00",
          family: "tron"
        })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FAMILY_MISMATCH");
  });
});
