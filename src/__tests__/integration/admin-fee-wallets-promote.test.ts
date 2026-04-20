import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressPool, feeWallets } from "../../db/schema.js";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";
import { initializePool } from "../../core/domain/pool.service.js";

const ADMIN_KEY = "super-secret-admin-key-that-is-at-least-32-chars";

describe("POST /admin/fee-wallets/from-pool-address", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY }, skipPoolInit: true });
    await initializePool(booted.deps, { families: ["evm"], initialSize: 3 });
  });

  afterEach(async () => {
    await booted.close();
  });

  async function post(body: unknown): Promise<Response> {
    return booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/from-pool-address", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify(body)
      })
    );
  }

  it("promotes an existing pool address into a fee wallet, reusing its derivation index", async () => {
    const [poolRow] = await booted.deps.db.select().from(addressPool).limit(1);
    expect(poolRow).toBeDefined();

    const res = await post({
      family: "evm",
      address: poolRow!.address,
      label: "promoted-hot-1",
      chainIds: [999]
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      feeWallet: {
        address: string;
        label: string;
        family: string;
        chainIds: number[];
        derivationIndex: number;
        poolDeactivated: boolean;
      };
    };
    expect(body.feeWallet.family).toBe("evm");
    expect(body.feeWallet.label).toBe("promoted-hot-1");
    expect(body.feeWallet.address).toBe(poolRow!.address);
    // The key invariant: the new fee wallet's derivationIndex MATCHES the
    // pool row's index. If this ever drifts, the signer would derive the
    // wrong key and payouts would fail at broadcast.
    expect(body.feeWallet.derivationIndex).toBe(poolRow!.addressIndex);
    expect(body.feeWallet.poolDeactivated).toBe(true);

    // Persisted row reflects the supplied index.
    const [feeRow] = await booted.deps.db
      .select({ derivationIndex: feeWallets.derivationIndex, address: feeWallets.address })
      .from(feeWallets)
      .where(eq(feeWallets.label, "promoted-hot-1"))
      .limit(1);
    expect(feeRow?.derivationIndex).toBe(poolRow!.addressIndex);
    expect(feeRow?.address).toBe(poolRow!.address);

    // Pool slot is quarantined (not deleted) so the audit trail survives
    // and late invoice payments resolving through invoice_receive_addresses
    // still land correctly.
    const [poolAfter] = await booted.deps.db
      .select({ status: addressPool.status })
      .from(addressPool)
      .where(eq(addressPool.id, poolRow!.id))
      .limit(1);
    expect(poolAfter?.status).toBe("quarantined");
  });

  it("accepts deactivatePoolSlot: false and leaves the pool row available", async () => {
    const [poolRow] = await booted.deps.db.select().from(addressPool).limit(1);

    const res = await post({
      family: "evm",
      address: poolRow!.address,
      label: "shared-hot",
      chainIds: [999],
      deactivatePoolSlot: false
    });
    expect(res.status).toBe(201);

    const [poolAfter] = await booted.deps.db
      .select({ status: addressPool.status })
      .from(addressPool)
      .where(eq(addressPool.id, poolRow!.id))
      .limit(1);
    expect(poolAfter?.status).toBe("available");
  });

  it("404s when the address isn't in the pool (external addresses aren't supported)", async () => {
    const res = await post({
      family: "evm",
      address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      label: "external-attempt",
      chainIds: [999]
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("POOL_ADDRESS_NOT_FOUND");
  });

  it("401s without an admin key", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/from-pool-address", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/fee-wallets/from-index", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { ADMIN_KEY } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("registers a fee wallet at an operator-supplied HD index (no pool row required)", async () => {
    // Index must be in the fee-wallet region [0x40000000, 0x7EFFFFFF] —
    // schema rejects pool-space (< 0x40000000) and sweep-master space
    // (>= 0x7F000000) to prevent accidental key collision with invoice
    // receive addresses or the family sweep master.
    const MANUAL_IDX = 0x40000000 + 42;
    const res = await booted.app.fetch(
      new Request("http://test.local/admin/fee-wallets/from-index", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({
          family: "evm",
          derivationIndex: MANUAL_IDX,
          label: "manual-ix-42",
          chainIds: [999]
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      feeWallet: { address: string; derivationIndex: number };
    };
    expect(body.feeWallet.derivationIndex).toBe(MANUAL_IDX);

    // Verify the persisted row's address matches what deriveAddress returns
    // at the supplied index. This is the invariant that lets the signer
    // reproduce the key at exec time.
    const adapter = booted.deps.chains.find((c) => c.family === "evm")!;
    const seed = "test test test test test test test test test test test junk";
    const { address } = adapter.deriveAddress(seed, MANUAL_IDX);
    expect(body.feeWallet.address).toBe(adapter.canonicalizeAddress(address));
  });
});
