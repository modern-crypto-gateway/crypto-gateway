import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

// Solana public keys are 32-byte ed25519 public keys, displayed as base58 strings.
// Accounts on Solana range 32-44 characters in base58 (rare extreme values).

// Valid if the string decodes to exactly 32 bytes. base58 has no checksum like
// Tron; we just require the decoded length.
export function isValidSolanaAddress(addr: string): boolean {
  try {
    const bytes = base58.decode(addr);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

export function publicKeyBytesToAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Solana public key must be 32 bytes, got ${publicKey.length}`);
  }
  return base58.encode(publicKey);
}

export function addressToPublicKeyBytes(address: string): Uint8Array {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) {
    throw new Error(`Solana address decode: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

// Solana derives the public key from the 32-byte ed25519 seed directly.
export function publicKeyFromPrivateKey(privateKey32: Uint8Array): Uint8Array {
  if (privateKey32.length !== 32) {
    throw new Error(`Solana privateKey must be 32 bytes, got ${privateKey32.length}`);
  }
  return ed25519.getPublicKey(privateKey32);
}

// Solana's "private key" as most wallets store it is the 64-byte concat of
// the 32-byte ed25519 seed and the 32-byte public key. We store only the seed
// in the SignerStore and reconstruct the 64-byte form when signing.
export function expandedSecretKey(privateKey32: Uint8Array, publicKey32: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(privateKey32, 0);
  out.set(publicKey32, 32);
  return out;
}
