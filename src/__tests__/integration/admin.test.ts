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
