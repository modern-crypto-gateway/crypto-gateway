import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

// Tron address algorithm (same secp256k1 as Ethereum, different encoding):
//   1. pubkey (uncompressed, 65 bytes starting with 0x04)
//   2. drop the 0x04 prefix -> 64 bytes (X || Y)
//   3. keccak256 -> 32 bytes
//   4. take the last 20 bytes -> the "EVM-equivalent" address
//   5. prepend the 0x41 network byte -> 21 bytes
//   6. SHA256 twice, take first 4 bytes -> 4-byte checksum
//   7. concat(21 bytes + 4 checksum) -> 25 bytes
//   8. base58 encode -> 34-character "T..."-prefixed string

// Network prefix byte. 0x41 ("A") for mainnet, Nile testnet, and Shasta — all
// Tron-family networks share the same prefix.
export const TRON_ADDRESS_PREFIX = 0x41;

// Private key (hex with 0x prefix or 64 hex chars) -> Tron base58 address.
export function privateKeyToTronAddress(privateKeyHex: string): string {
  const keyBytes = hexToBytes(privateKeyHex);
  if (keyBytes.length !== 32) {
    throw new Error(`Tron privateKey must be 32 bytes, got ${keyBytes.length}`);
  }
  // Uncompressed pubkey = 65 bytes (0x04 || X || Y).
  const uncompressedPub = secp256k1.getPublicKey(keyBytes, false);
  const pubBytes = uncompressedPub.subarray(1); // drop the 0x04 prefix
  const hash = keccak_256(pubBytes);
  const core = hash.subarray(hash.length - 20); // last 20 bytes
  return encodeTronAddress(core);
}

// 20-byte core address (like an EVM address) -> Tron base58 string.
export function encodeTronAddress(coreAddress20Bytes: Uint8Array): string {
  if (coreAddress20Bytes.length !== 20) {
    throw new Error(`coreAddress must be 20 bytes, got ${coreAddress20Bytes.length}`);
  }
  const prefixed = new Uint8Array(21);
  prefixed[0] = TRON_ADDRESS_PREFIX;
  prefixed.set(coreAddress20Bytes, 1);
  const checksum = sha256(sha256(prefixed)).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(prefixed, 0);
  full.set(checksum, 21);
  return base58.encode(full);
}

// Tron base58 -> 21-byte prefixed address (prefix + 20 bytes of core).
// Throws on bad checksum or bad length.
export function decodeTronAddress(base58Address: string): Uint8Array {
  const bytes = base58.decode(base58Address);
  if (bytes.length !== 25) {
    throw new Error(`Tron address decode: expected 25 bytes, got ${bytes.length}`);
  }
  const payload = bytes.subarray(0, 21);
  const checksum = bytes.subarray(21);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error(`Tron address decode: bad checksum for ${base58Address}`);
    }
  }
  if (payload[0] !== TRON_ADDRESS_PREFIX) {
    throw new Error(`Tron address decode: unexpected prefix 0x${payload[0]!.toString(16)}`);
  }
  return payload;
}

// Tron hex address ("41" + 40 hex chars) -> base58. Used when TronGrid returns
// logs/transactions with the hex form.
export function hexAddressToTron(hexAddress: string): string {
  const clean = hexAddress.toLowerCase().replace(/^0x/, "");
  if (clean.length !== 42 || !clean.startsWith("41")) {
    throw new Error(`Tron hex address must start with 41 and be 42 hex chars, got ${hexAddress}`);
  }
  const bytes = hexToBytes(clean);
  return encodeTronAddress(bytes.subarray(1));
}

// base58 Tron address -> "0x41..." hex. Used when building TRC-20 calldata
// that mirrors ERC-20's transfer(address,uint256): the contract expects the
// EVM-equivalent 20-byte address zero-padded to 32 bytes.
export function tronToEvmCoreHex(base58Address: string): string {
  const decoded = decodeTronAddress(base58Address);
  const core = decoded.subarray(1); // drop 0x41 prefix
  return `0x${bytesToHex(core)}`;
}

export function isValidTronAddress(addr: string): boolean {
  try {
    decodeTronAddress(addr);
    return true;
  } catch {
    return false;
  }
}

// ---- Local hex helpers (keep this file standalone for tests) ----

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error(`hex string must have even length: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
