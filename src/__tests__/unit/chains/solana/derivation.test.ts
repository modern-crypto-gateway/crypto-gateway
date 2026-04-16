import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  solanaChainAdapter,
  SOLANA_MAINNET_CHAIN_ID
} from "../../../../adapters/chains/solana/solana-chain.adapter.js";
import {
  addressToPublicKeyBytes,
  isValidSolanaAddress,
  publicKeyBytesToAddress,
  publicKeyFromPrivateKey
} from "../../../../adapters/chains/solana/solana-address.js";
import {
  derivePath,
  masterNodeFromSeed,
  deriveChildHardened
} from "../../../../adapters/chains/solana/slip10.js";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

describe("solana slip10 ed25519 derivation", () => {
  it("derives a 32+32 master node from a BIP39 seed", () => {
    const seed = mnemonicToSeedSync(HARDHAT_MNEMONIC);
    const master = masterNodeFromSeed(seed);
    expect(master.privateKey).toHaveLength(32);
    expect(master.chainCode).toHaveLength(32);
  });

  it("is deterministic: same seed + path yields identical keys", () => {
    const seed = mnemonicToSeedSync(HARDHAT_MNEMONIC);
    const a = derivePath(seed, "m/44'/501'/0'/0'");
    const b = derivePath(seed, "m/44'/501'/0'/0'");
    expect(a.privateKey).toEqual(b.privateKey);
    expect(a.chainCode).toEqual(b.chainCode);
  });

  it("rejects non-hardened path segments (ed25519 requires all levels hardened)", () => {
    const seed = mnemonicToSeedSync(HARDHAT_MNEMONIC);
    expect(() => derivePath(seed, "m/44'/501'/0/0'")).toThrow(/hardened/i);
  });

  it("rejects hardened indices >= 2^31 as out of range for the unhardened argument", () => {
    const master = masterNodeFromSeed(mnemonicToSeedSync(HARDHAT_MNEMONIC));
    expect(() => deriveChildHardened(master, 0x80000000)).toThrow();
    expect(() => deriveChildHardened(master, -1)).toThrow();
  });
});

describe("solana-address helpers", () => {
  it("round-trips a 32-byte public key through base58", () => {
    const seed = mnemonicToSeedSync(HARDHAT_MNEMONIC);
    const { privateKey } = derivePath(seed, "m/44'/501'/0'/0'");
    const pub = publicKeyFromPrivateKey(privateKey);
    const addr = publicKeyBytesToAddress(pub);
    const back = addressToPublicKeyBytes(addr);
    expect(back).toEqual(pub);
  });

  it("isValidSolanaAddress accepts a real derived address", () => {
    const seed = mnemonicToSeedSync(HARDHAT_MNEMONIC);
    const { privateKey } = derivePath(seed, "m/44'/501'/0'/0'");
    const addr = publicKeyBytesToAddress(publicKeyFromPrivateKey(privateKey));
    expect(isValidSolanaAddress(addr)).toBe(true);
  });

  it("isValidSolanaAddress rejects bogus strings", () => {
    expect(isValidSolanaAddress("")).toBe(false);
    expect(isValidSolanaAddress("0xdeadbeef")).toBe(false); // EVM-looking
    expect(isValidSolanaAddress("TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL")).toBe(false); // Tron, 34 chars — decodes to 25 bytes, not 32
    expect(isValidSolanaAddress("not-real")).toBe(false);
  });
});

describe("solanaChainAdapter.deriveAddress", () => {
  const adapter = solanaChainAdapter({
    chainIds: [SOLANA_MAINNET_CHAIN_ID],
    clients: {} // no RPC needed for address ops
  });

  it("produces a valid base58 Solana address + 32-byte private key from a BIP39 mnemonic", () => {
    const { address, privateKey } = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    expect(isValidSolanaAddress(address)).toBe(true);
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = adapter.deriveAddress(HARDHAT_MNEMONIC, 5);
    const b = adapter.deriveAddress(HARDHAT_MNEMONIC, 5);
    expect(a).toEqual(b);
  });

  it("produces distinct addresses for distinct indices", () => {
    const a0 = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const a1 = adapter.deriveAddress(HARDHAT_MNEMONIC, 1);
    expect(a0.address).not.toBe(a1.address);
    expect(a0.privateKey).not.toBe(a1.privateKey);
  });

  it("the derived private key produces the derived public key (ed25519 round-trip)", () => {
    const { address, privateKey } = adapter.deriveAddress(HARDHAT_MNEMONIC, 7);
    const privBytes = hexToBytes(privateKey);
    const pub = ed25519.getPublicKey(privBytes);
    expect(publicKeyBytesToAddress(pub)).toBe(address);
  });

  it("uses Solana's coin type 501 — differs from EVM (60) and Tron (195)", () => {
    // Not a specific vector, just a non-overlap check: the derived 32-byte
    // private key at Solana's path must NOT equal what the EVM coin-60 path
    // would give. We compare against the Hardhat-known EVM key at index 0.
    const evmKeyAtIndex0 = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const { privateKey } = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    expect(privateKey.replace(/^0x/, "")).not.toBe(evmKeyAtIndex0);
  });
});

describe("solanaChainAdapter.canonicalizeAddress / validateAddress / nativeSymbol", () => {
  const adapter = solanaChainAdapter({ chainIds: [SOLANA_MAINNET_CHAIN_ID], clients: {} });

  it("accepts a real base58 address and returns it unchanged", () => {
    const { address } = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    expect(adapter.canonicalizeAddress(address)).toBe(address);
    expect(adapter.validateAddress(address)).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(adapter.validateAddress("")).toBe(false);
    expect(() => adapter.canonicalizeAddress("not-an-address")).toThrow();
  });

  it("nativeSymbol is always SOL on any Solana chain id", () => {
    expect(adapter.nativeSymbol(SOLANA_MAINNET_CHAIN_ID)).toBe("SOL");
  });
});

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
