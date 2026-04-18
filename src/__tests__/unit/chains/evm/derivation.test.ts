import { describe, expect, it } from "vitest";
import { custom } from "viem";
import { evmChainAdapter } from "../../../../adapters/chains/evm/evm-chain.adapter.js";

// The well-known Hardhat / Anvil test mnemonic. The first three derived
// accounts at m/44'/60'/0'/0/{index} are stable across every EVM library
// (viem, ethers, web3.js, wagmi) and make safe fixtures.
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

// All addresses are stored / returned LOWERCASE — see
// `evmChainAdapter.canonicalizeAddress` for the rationale (case-sensitive
// SQLite joins must not depend on EIP-55 checksum case).
const HARDHAT_DERIVED = [
  {
    index: 0,
    address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  },
  {
    index: 1,
    address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  },
  {
    index: 2,
    address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  }
];

// A no-op transport so constructing the adapter doesn't require RPC URLs
// in pure-crypto tests.
const noopTransport = custom({ async request() { throw new Error("no RPC in this test"); } });

function makeAdapter(): ReturnType<typeof evmChainAdapter> {
  return evmChainAdapter({
    chainIds: [1, 137, 8453, 42161, 11155111, 999],
    transports: {
      1: noopTransport,
      137: noopTransport,
      8453: noopTransport,
      42161: noopTransport,
      11155111: noopTransport,
      999: noopTransport
    }
  });
}

describe("evmChainAdapter.deriveAddress", () => {
  it("produces the canonical Hardhat test accounts from the standard mnemonic", () => {
    const adapter = makeAdapter();
    for (const expected of HARDHAT_DERIVED) {
      const { address, privateKey } = adapter.deriveAddress(HARDHAT_MNEMONIC, expected.index);
      expect(address).toBe(expected.address);
      expect(privateKey).toBe(expected.privateKey);
    }
  });

  it("is deterministic: same seed + index always yields the same pair", () => {
    const adapter = makeAdapter();
    const a1 = adapter.deriveAddress(HARDHAT_MNEMONIC, 42);
    const a2 = adapter.deriveAddress(HARDHAT_MNEMONIC, 42);
    expect(a1).toEqual(a2);
  });

  it("produces distinct addresses for distinct indices", () => {
    const adapter = makeAdapter();
    const a0 = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const a1 = adapter.deriveAddress(HARDHAT_MNEMONIC, 1);
    expect(a0.address).not.toBe(a1.address);
    expect(a0.privateKey).not.toBe(a1.privateKey);
  });

  it("throws on an invalid mnemonic", () => {
    const adapter = makeAdapter();
    expect(() => adapter.deriveAddress("not a real mnemonic", 0)).toThrow();
  });
});

describe("evmChainAdapter.canonicalizeAddress (lowercase canonical)", () => {
  // Background: EVM addresses are case-insensitive on chain. EIP-55 mixed
  // case is purely a typo-detection hint. We store + compare lowercase so
  // SQLite joins between detected transfers and invoice/pool rows can't
  // miss because of a single mismatched character — a bug class that
  // silently orphaned every confirmed payment in production for one user.
  const VITALIK = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

  it("converts an EIP-55 mixed-case address to lowercase", () => {
    const adapter = makeAdapter();
    expect(adapter.canonicalizeAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(VITALIK);
  });

  it("converts an all-uppercase address to lowercase", () => {
    const adapter = makeAdapter();
    expect(adapter.canonicalizeAddress("0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045")).toBe(VITALIK);
  });

  it("round-trips: lowercase stays lowercase", () => {
    const adapter = makeAdapter();
    expect(adapter.canonicalizeAddress(VITALIK)).toBe(VITALIK);
  });

  it("any case form canonicalizes to the same string (join-safety)", () => {
    const adapter = makeAdapter();
    const a = adapter.canonicalizeAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
    const b = adapter.canonicalizeAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    const c = adapter.canonicalizeAddress("0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("throws on a bogus address", () => {
    const adapter = makeAdapter();
    expect(() => adapter.canonicalizeAddress("0xnothex")).toThrow();
    expect(() => adapter.canonicalizeAddress("0x123")).toThrow();
  });
});

describe("evmChainAdapter.validateAddress", () => {
  it("accepts valid EVM addresses in any case form", () => {
    const adapter = makeAdapter();
    expect(adapter.validateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(true);
    expect(adapter.validateAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    const adapter = makeAdapter();
    expect(adapter.validateAddress("nope")).toBe(false);
    expect(adapter.validateAddress("0x123")).toBe(false);
    expect(adapter.validateAddress("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
  });
});

describe("evmChainAdapter.nativeSymbol", () => {
  it("maps known chain ids to their native asset symbols", () => {
    const adapter = makeAdapter();
    expect(adapter.nativeSymbol(1)).toBe("ETH");
    expect(adapter.nativeSymbol(137)).toBe("POL");
    expect(adapter.nativeSymbol(8453)).toBe("ETH");
  });
});
