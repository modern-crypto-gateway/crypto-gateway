import { describe, expect, it } from "vitest";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  hdSignerStore,
  NoAdapterForFamilyError,
  UnsupportedSignerOperationError
} from "../../adapters/signer-store/hd.adapter.js";

const SEED = "test test test test test test test test test test test junk";

describe("hdSignerStore", () => {
  it("derives the same private key as the adapter for pool-address scopes", async () => {
    const adapter = devChainAdapter();
    const store = hdSignerStore({ masterSeed: SEED, chains: [adapter] });

    const derivationIndex = 42;
    const expected = adapter.deriveAddress(SEED, derivationIndex).privateKey;
    const actual = await store.get({ kind: "pool-address", family: "evm", derivationIndex });
    expect(actual).toBe(expected);
  });

  it("pool-address derivation is deterministic across calls", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 7 });
    const b = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 7 });
    expect(a).toBe(b);
  });

  it("different derivationIndex values produce different private keys", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 1 });
    const b = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 2 });
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
      store.put({ kind: "pool-address", family: "evm", derivationIndex: 0 }, "0xdeadbeef")
    ).rejects.toBeInstanceOf(UnsupportedSignerOperationError);
  });

  it("throws NoAdapterForFamilyError when the family isn't wired", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.get({ kind: "pool-address", family: "tron", derivationIndex: 1 })
    ).rejects.toBeInstanceOf(NoAdapterForFamilyError);
  });

  it("has() reports true for wired families and for receive-hd", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    expect(await store.has({ kind: "receive-hd" })).toBe(true);
    expect(await store.has({ kind: "pool-address", family: "evm", derivationIndex: 0 })).toBe(true);
    expect(await store.has({ kind: "pool-address", family: "tron", derivationIndex: 0 })).toBe(false);
  });

  it("delete() is a no-op (keys aren't stored)", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.delete({ kind: "pool-address", family: "evm", derivationIndex: 0 })
    ).resolves.toBeUndefined();
    const k = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 0 });
    expect(typeof k).toBe("string");
  });
});
