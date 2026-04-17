import { describe, expect, it } from "vitest";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  feeWalletIndex,
  hdSignerStore,
  NoAdapterForFamilyError,
  UnsupportedSignerOperationError
} from "../../adapters/signer-store/hd.adapter.js";

const SEED = "test test test test test test test test test test test junk";

describe("hdSignerStore", () => {
  it("derives the same private key as the adapter for fee-wallet scopes", async () => {
    const adapter = devChainAdapter();
    const store = hdSignerStore({ masterSeed: SEED, chains: [adapter] });

    const label = "hot-1";
    const expected = adapter.deriveAddress(SEED, feeWalletIndex("evm", label)).privateKey;
    const actual = await store.get({ kind: "fee-wallet", family: "evm", label });
    expect(actual).toBe(expected);
  });

  it("fee-wallet derivation is deterministic across calls", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "fee-wallet", family: "evm", label: "hot-1" });
    const b = await store.get({ kind: "fee-wallet", family: "evm", label: "hot-1" });
    expect(a).toBe(b);
  });

  it("different labels derive to different private keys", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "fee-wallet", family: "evm", label: "hot-1" });
    const b = await store.get({ kind: "fee-wallet", family: "evm", label: "hot-2" });
    expect(a).not.toBe(b);
  });

  it("sweep-master key is stable for a family", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "sweep-master", family: "evm" });
    const b = await store.get({ kind: "sweep-master", family: "evm" });
    expect(a).toBe(b);
  });

  it("receive-hd returns the master seed itself", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const v = await store.get({ kind: "receive-hd" });
    expect(v).toBe(SEED);
  });

  it("put() throws — external-key import is not supported", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.put({ kind: "fee-wallet", family: "evm", label: "hot-1" }, "0xdeadbeef")
    ).rejects.toBeInstanceOf(UnsupportedSignerOperationError);
  });

  it("throws NoAdapterForFamilyError when the family isn't wired", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.get({ kind: "fee-wallet", family: "tron", label: "hot-1" })
    ).rejects.toBeInstanceOf(NoAdapterForFamilyError);
  });

  it("has() reports true for wired families and for receive-hd", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    expect(await store.has({ kind: "receive-hd" })).toBe(true);
    expect(await store.has({ kind: "fee-wallet", family: "evm", label: "x" })).toBe(true);
    expect(await store.has({ kind: "fee-wallet", family: "tron", label: "x" })).toBe(false);
  });

  it("delete() is a no-op (keys aren't stored)", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.delete({ kind: "fee-wallet", family: "evm", label: "hot-1" })
    ).resolves.toBeUndefined();
    // Key is still derivable afterwards — delete didn't invalidate anything.
    const k = await store.get({ kind: "fee-wallet", family: "evm", label: "hot-1" });
    expect(typeof k).toBe("string");
  });
});

describe("feeWalletIndex", () => {
  it("returns an index in the fee-wallet region [0x40000000, 0x7EFFFFFF]", () => {
    const idx = feeWalletIndex("evm", "hot-1");
    expect(idx).toBeGreaterThanOrEqual(0x40000000);
    expect(idx).toBeLessThanOrEqual(0x7effffff);
  });

  it("is deterministic across calls", () => {
    expect(feeWalletIndex("evm", "hot-1")).toBe(feeWalletIndex("evm", "hot-1"));
    expect(feeWalletIndex("tron", "cold-archive")).toBe(feeWalletIndex("tron", "cold-archive"));
  });

  it("different (family, label) pairs produce different indices in practice", () => {
    const a = feeWalletIndex("evm", "hot-1");
    const b = feeWalletIndex("evm", "hot-2");
    const c = feeWalletIndex("tron", "hot-1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
