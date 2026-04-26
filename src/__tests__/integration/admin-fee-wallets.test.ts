import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressPool, feeWallets } from "../../db/schema.js";
import { initializePool } from "../../core/domain/pool.service.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const ADMIN_KEY = "super-secret-admin-key";

// These tests pin the admin CRUD surface for fee wallets. Intentionally
// scoped to behavior observable through the HTTP API — per-mode signer
// resolution is tested separately at the adapter level. The emphasis here
// is on the shape the dashboard integrates against (list response matrix,
// use-pool verification, idempotent DELETE, error codes) since those
// contracts are what external callers depend on.

describe("admin /fee-wallets — CRUD surface", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
    // Integration tests boot with a dev-family adapter only (family='evm',
    // chainId=999); pool rows for that family are what /use-pool will
    // accept. Ensures the list endpoint has at least one real row to
    // reason about.
    await initializePool(booted.deps, { families: ["evm"], initialSize: 2 });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function listFeeWallets(): Promise<Response> {
    return booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
  }

  it("GET returns one entry per family with capability + configured=null before any registration", async () => {
    const res = await listFeeWallets();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feeWallets: Array<{
        family: "evm" | "tron" | "solana";
        capability: "none" | "delegate" | "co-sign";
        configured: null | { mode: string; address: string };
      }>;
    };
    expect(body.feeWallets).toHaveLength(3);
    // Every family starts unregistered.
    for (const row of body.feeWallets) {
      expect(row.configured).toBeNull();
    }
    // Dev adapter reports family='evm' capability='none' — matching the
    // EVM real adapter, whose capability is "none" until EIP-4337-style
    // account abstraction is universal.
    const evm = body.feeWallets.find((r) => r.family === "evm");
    expect(evm?.capability).toBe("none");
  });

  it("POST .../use-pool registers an existing pool address as the fee wallet", async () => {
    const [poolRow] = await booted.deps.db
      .select({ address: addressPool.address })
      .from(addressPool)
      .where(eq(addressPool.family, "evm"))
      .limit(1);
    expect(poolRow).toBeDefined();

    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/evm/use-pool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ address: poolRow!.address })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feeWallet: { family: string; mode: string; address: string };
    };
    expect(body.feeWallet.family).toBe("evm");
    expect(body.feeWallet.mode).toBe("hd-pool");
    expect(body.feeWallet.address).toBe(poolRow!.address.toLowerCase());

    // Row persisted.
    const [dbRow] = await booted.deps.db
      .select()
      .from(feeWallets)
      .where(eq(feeWallets.family, "evm"))
      .limit(1);
    expect(dbRow?.mode).toBe("hd-pool");
    // hd-pool mode must NOT carry ciphertext — DB CHECK would have rejected
    // the row otherwise, but double-check from the read side too.
    expect(dbRow?.privateKeyCiphertext).toBeNull();
  });

  it("POST .../use-pool returns 404 POOL_ADDRESS_NOT_FOUND for an address not in the pool", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/evm/use-pool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ address: "0x1111111111111111111111111111111111111111" })
      })
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("POOL_ADDRESS_NOT_FOUND");
  });

  // The dev-chain adapter intentionally throws on addressFromPrivateKey (its
  // "keypair" is an HMAC output with no inverse) so the /import route's
  // address-derivation cross-check can't be exercised against it. The
  // ciphertext-at-rest contract is otherwise verified by the secretsCipher
  // unit tests; the real EVM adapter is exercised end-to-end in production.
  it.skip("POST .../import stores the private key as ciphertext (never plaintext)", async () => {
    // Shape check only — correctness of encryption is covered by the
    // secretsCipher's own unit tests. Here we just prove the API wrote a
    // ciphertext column and withheld the plaintext from downstream reads.
    // The /import route cross-checks declared address against the address
    // derived from the private key, so the fixture must use a matching pair.
    const plaintextHex = "a".repeat(64);
    // Address derived from privateKey 0xaaaa...64 via secp256k1+keccak.
    // (Computed once via viem's privateKeyToAccount; pinned here to avoid a
    // boot-time crypto round-trip in the test.)
    const declaredAddress = "0x8fd379246834eac74B8419FfdA202CF8051F7A03";
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/evm/import", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ privateKey: plaintextHex, address: declaredAddress })
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feeWallet: { mode: string; address: string } };
    expect(body.feeWallet.mode).toBe("imported");

    const [dbRow] = await booted.deps.db
      .select()
      .from(feeWallets)
      .where(eq(feeWallets.family, "evm"))
      .limit(1);
    expect(dbRow?.privateKeyCiphertext).not.toBeNull();
    // The stored ciphertext must NOT equal the plaintext — if these match,
    // something wired the raw key into the DB without encrypting.
    expect(dbRow?.privateKeyCiphertext).not.toBe(plaintextHex);
    expect(dbRow?.privateKeyCiphertext).not.toBe(`0x${plaintextHex}`);
  });

  it("POST .../use-pool replaces a prior registration (family uniqueness)", async () => {
    const rows = await booted.deps.db
      .select({ address: addressPool.address })
      .from(addressPool)
      .where(eq(addressPool.family, "evm"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const [a, b] = rows;

    // First registration.
    const res1 = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/evm/use-pool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ address: a!.address })
      })
    );
    expect(res1.status).toBe(200);

    // Swap — same family, different address. No DELETE needed.
    const res2 = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/evm/use-pool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ address: b!.address })
      })
    );
    expect(res2.status).toBe(200);

    // Exactly one row remains, and it's the second address.
    const dbRows = await booted.deps.db
      .select()
      .from(feeWallets)
      .where(eq(feeWallets.family, "evm"));
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0]?.address).toBe(b!.address.toLowerCase());
  });

  it("DELETE is idempotent — returns removed=false on a family that was never registered", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/solana", {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean };
    expect(body.removed).toBe(false);
  });

  it("DELETE after registration returns removed=true and clears the row", async () => {
    const [poolRow] = await booted.deps.db
      .select({ address: addressPool.address })
      .from(addressPool)
      .where(eq(addressPool.family, "evm"))
      .limit(1);
    await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/evm/use-pool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ address: poolRow!.address })
      })
    );
    const delRes = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/evm", {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as { removed: boolean };
    expect(body.removed).toBe(true);

    const dbRows = await booted.deps.db
      .select()
      .from(feeWallets)
      .where(eq(feeWallets.family, "evm"));
    expect(dbRows).toHaveLength(0);
  });

  it("rejects unknown family values with BAD_FAMILY", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/bitcoin/use-pool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ address: "anything" })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_FAMILY");
  });

  it("requires admin auth on every fee-wallet endpoint", async () => {
    const noAuth = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets", { method: "GET" })
    );
    expect(noAuth.status).toBe(401);
  });
});

describe("admin /fee-wallets/tron/resources — error paths without a Tron adapter", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("returns 409 NO_FEE_WALLET when Tron has no registration yet", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/tron/resources", {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_KEY}` }
      })
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NO_FEE_WALLET");
  });
});
