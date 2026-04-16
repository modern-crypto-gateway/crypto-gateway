import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeTronAddress,
  encodeTronAddress,
  isValidTronAddress,
  privateKeyToTronAddress
} from "../../../../adapters/chains/tron/tron-address.js";
import { tronChainAdapter } from "../../../../adapters/chains/tron/tron-chain.adapter.js";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

// From the Hardhat test accounts at BIP44 path m/44'/60'/0'/0/0.
const HARDHAT_INDEX_0 = {
  privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  ethAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
};

describe("tron-address", () => {
  it("round-trips: encode then decode returns the same 21-byte payload", () => {
    // Arbitrary 20-byte core address.
    const core = new Uint8Array(20);
    for (let i = 0; i < 20; i++) core[i] = i;
    const base58 = encodeTronAddress(core);
    expect(base58).toMatch(/^T[a-km-zA-HJ-NP-Z1-9]{33}$/);
    const decoded = decodeTronAddress(base58);
    expect(decoded.length).toBe(21);
    expect(decoded[0]).toBe(0x41);
    for (let i = 0; i < 20; i++) {
      expect(decoded[i + 1]).toBe(core[i]);
    }
  });

  it("rejects addresses with a tampered checksum", () => {
    const core = new Uint8Array(20);
    const base58 = encodeTronAddress(core);
    // Flip a character deep in the middle to corrupt the checksum (not the prefix byte).
    const mutated = `${base58.slice(0, 5)}${base58[5] === "z" ? "x" : "z"}${base58.slice(6)}`;
    expect(() => decodeTronAddress(mutated)).toThrow();
  });

  it("isValidTronAddress accepts canonical base58 and rejects nonsense", () => {
    const core = new Uint8Array(20);
    for (let i = 0; i < 20; i++) core[i] = 0x20 + i;
    const base58 = encodeTronAddress(core);
    expect(isValidTronAddress(base58)).toBe(true);
    expect(isValidTronAddress("T-not-really")).toBe(false);
    expect(isValidTronAddress("0xabcdef")).toBe(false);
    expect(isValidTronAddress("")).toBe(false);
  });

  it("privateKeyToTronAddress core bytes match the EVM address for the same private key", () => {
    // Cross-check: the Tron address's 20-byte core (the part after the 0x41 prefix)
    // must be identical to the EVM address derived from the same secp256k1 key,
    // because both use keccak256(uncompressedPub[1:]).slice(-20).
    const ethLower = privateKeyToAccount(HARDHAT_INDEX_0.privateKey as `0x${string}`).address.toLowerCase();
    const tron = privateKeyToTronAddress(HARDHAT_INDEX_0.privateKey);
    const decoded = decodeTronAddress(tron);
    let coreHex = "0x";
    for (let i = 1; i < decoded.length; i++) {
      coreHex += decoded[i]!.toString(16).padStart(2, "0");
    }
    expect(coreHex).toBe(ethLower);
  });
});

describe("tronChainAdapter.deriveAddress", () => {
  const adapter = tronChainAdapter({
    chainIds: [728126428],
    // The address methods never touch TronGrid, so no client config is needed.
    clients: {}
  });

  it("produces a valid Tron address from a BIP39 mnemonic deterministically", () => {
    const a1 = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const a2 = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    expect(a1).toEqual(a2);
    expect(isValidTronAddress(a1.address)).toBe(true);
    expect(a1.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces distinct addresses and keys for distinct BIP44 indices", () => {
    const a0 = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const a1 = adapter.deriveAddress(HARDHAT_MNEMONIC, 1);
    expect(a0.address).not.toBe(a1.address);
    expect(a0.privateKey).not.toBe(a1.privateKey);
  });

  it("uses Tron's coin type 195 (so the address is NOT the same as the EVM derivation at coin 60)", () => {
    // Sanity: if someone mistakenly used coin 60 for Tron, derived private keys
    // would match the Hardhat EVM test accounts. Coin 195 must diverge.
    const tron = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    expect(tron.privateKey).not.toBe(HARDHAT_INDEX_0.privateKey);
  });
});

describe("tronChainAdapter.canonicalizeAddress / validateAddress", () => {
  const adapter = tronChainAdapter({ chainIds: [728126428], clients: {} });

  it("accepts valid base58 and returns it unchanged", () => {
    const a = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    expect(adapter.canonicalizeAddress(a.address)).toBe(a.address);
    expect(adapter.validateAddress(a.address)).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(adapter.validateAddress("")).toBe(false);
    expect(adapter.validateAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
    expect(() => adapter.canonicalizeAddress("garbage")).toThrow();
  });
});

describe("tronChainAdapter.nativeSymbol", () => {
  it("always returns TRX regardless of chain id", () => {
    const adapter = tronChainAdapter({ chainIds: [728126428, 3448148188], clients: {} });
    expect(adapter.nativeSymbol(728126428)).toBe("TRX");
    expect(adapter.nativeSymbol(3448148188)).toBe("TRX");
  });
});
