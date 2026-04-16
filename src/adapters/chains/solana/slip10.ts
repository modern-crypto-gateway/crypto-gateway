import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";

// SLIP-0010 HD derivation for ed25519 (the curve Solana uses). Distinct from
// BIP32 (secp256k1) used by EVM/Tron. Key points:
//   - ALL derivation levels are hardened (index >= 2^31).
//   - Master key: I = HMAC-SHA512(key="ed25519 seed", msg=seed); IL=key, IR=chainCode.
//   - Child:      I = HMAC-SHA512(key=chainCode, msg=0x00 || parentKey || ser32(index | 0x80000000)).
// We re-implement here rather than pulling a package — the algorithm is ~50
// lines and avoids another transitive dep for bundle-size-sensitive deployments.

export interface HdNode {
  privateKey: Uint8Array; // 32 bytes (ed25519 seed)
  chainCode: Uint8Array;  // 32 bytes
}

const HARDENED_OFFSET = 0x80000000;
const ED25519_SEED_KEY = new TextEncoder().encode("ed25519 seed");

// Derive the master node from a BIP39 seed (64-byte output of mnemonicToSeedSync).
export function masterNodeFromSeed(seed: Uint8Array): HdNode {
  const I = hmac(sha512, ED25519_SEED_KEY, seed);
  return { privateKey: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

// Derive a child node at an (always-hardened) index.
export function deriveChildHardened(parent: HdNode, index: number): HdNode {
  if (index < 0 || index >= HARDENED_OFFSET) {
    throw new Error(`SLIP-0010 ed25519 requires an unhardened index in [0, 2^31); got ${index}`);
  }
  const hardenedIndex = index + HARDENED_OFFSET;
  const data = new Uint8Array(37);
  data[0] = 0x00;
  data.set(parent.privateKey, 1);
  // Big-endian u32 of the hardened index.
  data[33] = (hardenedIndex >>> 24) & 0xff;
  data[34] = (hardenedIndex >>> 16) & 0xff;
  data[35] = (hardenedIndex >>> 8) & 0xff;
  data[36] = hardenedIndex & 0xff;
  const I = hmac(sha512, parent.chainCode, data);
  return { privateKey: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

// Derive a node at a BIP44-style path like "m/44'/501'/0'/0'". Each segment
// MUST be hardened (trailing apostrophe); a non-hardened segment throws.
export function derivePath(seed: Uint8Array, path: string): HdNode {
  if (!/^m(\/\d+')*\/?$/.test(path) && !/^m(\/\d+')+$/.test(path)) {
    throw new Error(`SLIP-0010 ed25519 path must be all-hardened like m/44'/501'/0'/0' — got ${path}`);
  }
  let node = masterNodeFromSeed(seed);
  const segments = path.slice(2).split("/").filter(Boolean);
  for (const segment of segments) {
    if (!segment.endsWith("'")) {
      throw new Error(`SLIP-0010 ed25519 segment must be hardened: ${segment}`);
    }
    const index = Number(segment.slice(0, -1));
    if (!Number.isFinite(index) || index < 0) {
      throw new Error(`SLIP-0010 ed25519 segment index invalid: ${segment}`);
    }
    node = deriveChildHardened(node, index);
  }
  return node;
}
