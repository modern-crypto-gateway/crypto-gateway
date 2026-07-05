import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { moneroBase58Decode, moneroBase58Encode } from "./monero-base58.js";

// Monero crypto for v1 inbound detection. Pure TypeScript, no native deps —
// works on Node, Cloudflare Workers, and Vercel-Edge identically.
//
// Scope: address parsing, subaddress derivation under `account 0`, view-key
// cross-check (boot validation), output match against the gateway's
// subaddresses (shared-secret derivation), and RingCT v2 amount unblinding.
//
// Out of scope (deferred to v2 with payouts): tx construction, ring
// signatures, Bulletproofs, key images.
//
// References:
//   - Monero subaddress derivation: monero/src/cryptonote_basic/cryptonote_basic_impl.cpp
//   - Hs hash-to-scalar: monero/src/crypto/crypto.cpp
//   - RingCT amount encoding: monero/src/ringct/rctOps.cpp
//   - Address format: monero/src/cryptonote_basic/cryptonote_basic_impl.cpp:get_account_address_as_str
//
// Network bytes (the prefix byte before the keys in the encoded address):
//   mainnet  primary    = 0x12 (18)
//   mainnet  subaddress = 0x2A (42)
//   stagenet primary    = 0x18 (24)
//   stagenet subaddress = 0x24 (36)
//   testnet  primary    = 0x35 (53)
//   testnet  subaddress = 0x3F (63)

export type MoneroNetwork = "mainnet" | "stagenet" | "testnet";

export interface ParsedMoneroAddress {
  readonly network: MoneroNetwork;
  readonly isSubaddress: boolean;
  // 32-byte compressed ed25519 points.
  readonly publicSpendKey: Uint8Array;
  readonly publicViewKey: Uint8Array;
}

const NETWORK_BYTES: Readonly<
  Record<number, { network: MoneroNetwork; isSubaddress: boolean }>
> = {
  0x12: { network: "mainnet", isSubaddress: false },
  0x2a: { network: "mainnet", isSubaddress: true },
  0x18: { network: "stagenet", isSubaddress: false },
  0x24: { network: "stagenet", isSubaddress: true },
  0x35: { network: "testnet", isSubaddress: false },
  0x3f: { network: "testnet", isSubaddress: true }
};

const PRIMARY_NETWORK_BYTE: Readonly<Record<MoneroNetwork, number>> = {
  mainnet: 0x12,
  stagenet: 0x18,
  testnet: 0x35
};
const SUBADDRESS_NETWORK_BYTE: Readonly<Record<MoneroNetwork, number>> = {
  mainnet: 0x2a,
  stagenet: 0x24,
  testnet: 0x3f
};

// ed25519 group order ℓ = 2^252 + 27742317777372353535851937790883648493.
// Reduce hash-to-scalar mod this. (`@noble/curves` exposes `ed25519.Point.Fn.ORDER`.)
const ED25519_L: bigint = ed25519.Point.Fn.ORDER;

// Decode a Monero address (primary or subaddress) and return the network +
// the two public keys. Throws on malformed input — wrong checksum, unknown
// network byte, or wrong byte length.
//
// Address structure: <netByte:1> || <publicSpendKey:32> || <publicViewKey:32>
// || <checksum:4>, base58-encoded with Monero's split-block variant.
export function parseAddress(addrStr: string): ParsedMoneroAddress {
  let raw: Uint8Array;
  try {
    raw = moneroBase58Decode(addrStr);
  } catch (err) {
    throw new Error(`parseAddress: base58 decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw.length !== 1 + 32 + 32 + 4) {
    throw new Error(`parseAddress: expected 69 bytes (netByte+spend+view+checksum), got ${raw.length}`);
  }
  const netByte = raw[0]!;
  const meta = NETWORK_BYTES[netByte];
  if (!meta) {
    throw new Error(`parseAddress: unknown network byte 0x${netByte.toString(16)}`);
  }
  const body = raw.subarray(0, 1 + 64);
  const checksumActual = raw.subarray(65, 69);
  const checksumExpected = keccak_256(body).subarray(0, 4);
  if (!constantTimeEqual(checksumActual, checksumExpected)) {
    throw new Error("parseAddress: checksum mismatch (corrupt address?)");
  }
  return {
    network: meta.network,
    isSubaddress: meta.isSubaddress,
    publicSpendKey: raw.subarray(1, 33),
    publicViewKey: raw.subarray(33, 65)
  };
}

// Encode (network, isSubaddress, spendPub, viewPub) → Monero base58 address.
export function encodeAddress(args: {
  network: MoneroNetwork;
  isSubaddress: boolean;
  publicSpendKey: Uint8Array;
  publicViewKey: Uint8Array;
}): string {
  if (args.publicSpendKey.length !== 32 || args.publicViewKey.length !== 32) {
    throw new Error("encodeAddress: spend/view keys must be 32 bytes each");
  }
  const netByte = args.isSubaddress
    ? SUBADDRESS_NETWORK_BYTE[args.network]
    : PRIMARY_NETWORK_BYTE[args.network];
  const body = new Uint8Array(1 + 64);
  body[0] = netByte;
  body.set(args.publicSpendKey, 1);
  body.set(args.publicViewKey, 33);
  const checksum = keccak_256(body).subarray(0, 4);
  const full = new Uint8Array(body.length + 4);
  full.set(body);
  full.set(checksum, body.length);
  return moneroBase58Encode(full);
}

// Hash-to-scalar (Monero's Hs): keccak-256(input), interpreted as a
// little-endian uint, reduced mod the ed25519 group order ℓ.
export function hashToScalar(input: Uint8Array): bigint {
  const h = keccak_256(input);
  return leBytesToBigIntMod(h, ED25519_L);
}

// Cryptonote-style varint (LEB128 with the high bit as continuation flag).
// Used for serializing account/subaddress indices into the SubAddr derivation
// preimage and for output indices in the shared-secret hash.
export function encodeVarint(n: bigint | number): Uint8Array {
  let v = typeof n === "bigint" ? n : BigInt(n);
  if (v < 0n) throw new Error("encodeVarint: negative value");
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

// Derive subaddress at (account, index) from the merchant's master view key
// + primary public spend key. Returns the encoded subaddress string.
//
// Algorithm (account/index encoded as little-endian uint32 each):
//   m_scalar = Hs("SubAddr\x00" || viewKeySecret || account_le32 || index_le32) mod ℓ
//   D = primarySpendPub + m_scalar · G   ← subaddress public spend key
//   C = viewKeySecret · D                 ← subaddress public view key
//   Encode (subaddress netByte, D, C) → base58 string.
//
// Index 0/0 is special — it's the merchant's primary address, NOT a
// subaddress. We disallow it here and require account=0, index>=1.
export function deriveSubaddress(args: {
  network: MoneroNetwork;
  viewKeySecret: Uint8Array; // 32-byte scalar (already reduced mod ℓ)
  primarySpendPub: Uint8Array; // 32-byte ed25519 point
  account: number; // u32
  index: number; // u32
}): string {
  if (args.viewKeySecret.length !== 32) {
    throw new Error("deriveSubaddress: viewKeySecret must be 32 bytes");
  }
  if (args.primarySpendPub.length !== 32) {
    throw new Error("deriveSubaddress: primarySpendPub must be 32 bytes");
  }
  if (args.account < 0 || args.index < 0) {
    throw new Error("deriveSubaddress: account and index must be non-negative");
  }
  if (args.account === 0 && args.index === 0) {
    throw new Error("deriveSubaddress: (0,0) is the primary address, not a subaddress");
  }
  // Preimage: "SubAddr\x00" (8 bytes incl. null terminator) || viewSecret(32)
  // || account(4 LE) || index(4 LE)
  const prefix = new Uint8Array([0x53, 0x75, 0x62, 0x41, 0x64, 0x64, 0x72, 0x00]); // 8 bytes: "SubAddr" + NUL terminator (0x00, NOT a space)
  const accBytes = u32LE(args.account);
  const idxBytes = u32LE(args.index);
  const preimage = new Uint8Array(prefix.length + 32 + 4 + 4);
  preimage.set(prefix, 0);
  preimage.set(args.viewKeySecret, prefix.length);
  preimage.set(accBytes, prefix.length + 32);
  preimage.set(idxBytes, prefix.length + 36);
  const m = hashToScalar(preimage);

  const D = ed25519.Point.fromBytes(args.primarySpendPub).add(
    ed25519.Point.BASE.multiply(m === 0n ? 1n : m)
  );
  const viewScalar = leBytesToBigIntMod(args.viewKeySecret, ED25519_L);
  const C = D.multiply(viewScalar === 0n ? 1n : viewScalar);

  return encodeAddress({
    network: args.network,
    isSubaddress: true,
    publicSpendKey: D.toBytes(),
    publicViewKey: C.toBytes()
  });
}

// Boot-time sanity check: the supplied secret view key must derive back to
// the public view key embedded in the primary address. Mismatch = the
// operator pasted the wrong key and we'd silently fail to decode any
// incoming output.
export function viewKeyMatchesAddress(
  viewKeySecret: Uint8Array,
  primaryAddress: string
): boolean {
  if (viewKeySecret.length !== 32) return false;
  const parsed = parseAddress(primaryAddress);
  if (parsed.isSubaddress) return false; // must be the primary, not a subaddress
  const scalar = leBytesToBigIntMod(viewKeySecret, ED25519_L);
  if (scalar === 0n) return false;
  const derived = ed25519.Point.BASE.multiply(scalar).toBytes();
  return constantTimeEqual(derived, parsed.publicViewKey);
}

// Key derivation — Monero's `generate_key_derivation`:
//   D = 8 · viewSecret · txPubkey  (32-byte compressed point).
// The factor of 8 (cofactor) clears any small-subgroup component a hostile
// sender might have planted in `txPubkey`. D depends only on (viewKey,
// txPubkey) — NOT on the output index — so scanners compute it ONCE per tx
// pubkey and reuse it across every output. This is the single expensive
// ed25519 operation in the receive-side scan; everything downstream
// (`derivationToScalar`, `deriveViewTag`) is a keccak hash.
export function deriveKeyDerivation(args: {
  viewKeySecret: Uint8Array;
  txPubkey: Uint8Array; // 32-byte ed25519 point from the tx's `tx_pubkey`
}): Uint8Array {
  const viewScalar = leBytesToBigIntMod(args.viewKeySecret, ED25519_L);
  if (viewScalar === 0n) {
    throw new Error("deriveKeyDerivation: zero view scalar");
  }
  const txPub = ed25519.Point.fromBytes(args.txPubkey);
  return txPub.multiply(viewScalar).multiply(8n).toBytes();
}

// Monero's `derivation_to_scalar`: Hs(D || varint(outputIndex)) — keccak of
// the derivation + output index, reduced mod ℓ, re-encoded as 32 LE bytes.
// Same value `expectedOutputPubkey` consumes (as a scalar to multiply G by)
// AND the amount-decoding hash consumes (as bytes alongside the "amount"
// salt). Bit-compatible with monero/src/crypto/crypto.cpp:hash_to_scalar.
export function derivationToScalar(args: {
  derivation: Uint8Array; // deriveKeyDerivation output
  outputIndex: number; // 0-based index within the tx's output list
}): Uint8Array {
  const idx = encodeVarint(args.outputIndex);
  const preimage = new Uint8Array(args.derivation.length + idx.length);
  preimage.set(args.derivation, 0);
  preimage.set(idx, args.derivation.length);
  // sc_reduce32 — reduce the keccak output mod ℓ and re-encode as 32 LE bytes.
  const reduced = leBytesToBigIntMod(keccak_256(preimage), ED25519_L);
  return scalarToLEBytes32(reduced);
}

// View tag — Monero's `derive_view_tag` (crypto.cpp, mandatory on every
// output since hard fork v15, Aug 2022):
//   view_tag = keccak_256("view_tag" || derivation || varint(outputIndex))[0]
// ("view_tag" is the 8-byte ASCII salt, NO null terminator.)
// The sender computes the same byte from the same derivation, so a genuine
// output to us ALWAYS matches — using it as a prefilter has zero false
// negatives. ~1/256 foreign outputs false-positive through to the full
// (expensive) subaddress check, which rejects them. Outputs from pre-v15
// txs carry no tag; callers must bypass the prefilter for those.
const VIEW_TAG_SALT = new Uint8Array([0x76, 0x69, 0x65, 0x77, 0x5f, 0x74, 0x61, 0x67]); // "view_tag", 8 bytes, no NUL
export function deriveViewTag(args: {
  derivation: Uint8Array;
  outputIndex: number;
}): number {
  const idx = encodeVarint(args.outputIndex);
  const preimage = new Uint8Array(VIEW_TAG_SALT.length + args.derivation.length + idx.length);
  preimage.set(VIEW_TAG_SALT, 0);
  preimage.set(args.derivation, VIEW_TAG_SALT.length);
  preimage.set(idx, VIEW_TAG_SALT.length + args.derivation.length);
  return keccak_256(preimage)[0]!;
}

// Legacy convenience wrapper: derivation + hash-to-scalar in one call.
// Kept for callers/tests that don't need the per-tx derivation reuse or
// the view-tag prefilter; new scan paths should call `deriveKeyDerivation`
// once per tx pubkey and `derivationToScalar` per output instead.
export function deriveSharedSecret(args: {
  viewKeySecret: Uint8Array;
  txPubkey: Uint8Array; // 32-byte ed25519 point from the tx's `tx_pubkey`
  outputIndex: number; // 0-based index within the tx's output list
}): Uint8Array {
  const derivation = deriveKeyDerivation({
    viewKeySecret: args.viewKeySecret,
    txPubkey: args.txPubkey
  });
  return derivationToScalar({ derivation, outputIndex: args.outputIndex });
}

// For a given subaddress N owned by the merchant: compute the expected
// `output_pubkey` an incoming transfer to N would carry. Match against the
// actual `output_pubkey` to confirm the output belongs to that subaddress.
//
//   expected = sharedSecret · G + subaddressSpendPub_N
//
// `sharedSecret` is already a scalar (`deriveSharedSecret` did the
// hash-to-scalar reduction); we just decode the 32 LE bytes and multiply.
//
// NOTE: this is O(1) per (output, subaddress) pair — an O(N-subaddress)
// scan loop. New scan paths invert the equation instead (see
// `outputToSubaddressSpendPub`) for an O(1)-per-output map lookup, which is
// also exactly how wallet2's `derive_subaddress_public_key` + hashtable
// scanning works. Kept for tests and as the reference construction.
export function expectedOutputPubkey(args: {
  sharedSecret: Uint8Array;
  subaddressSpendPub: Uint8Array;
}): Uint8Array {
  const scalar = leBytesToBigIntMod(args.sharedSecret, ED25519_L);
  const safe = scalar === 0n ? 1n : scalar;
  const left = ed25519.Point.BASE.multiply(safe);
  const right = ed25519.Point.fromBytes(args.subaddressSpendPub);
  return left.add(right).toBytes();
}

// Invert the output-key equation to recover the candidate subaddress spend
// pub for an output — Monero's `derive_subaddress_public_key`:
//   D' = outputPubkey − Hs(derivation || i) · G
// If the output pays one of our subaddresses, D' equals that subaddress's
// public spend key; the scanner looks D' up in a precomputed map of watched
// spend pubs (one EC subtract per output instead of one EC add per output
// PER subaddress). Returns null when the output pubkey isn't a valid curve
// point — foreign garbage, never ours.
export function outputToSubaddressSpendPub(args: {
  hsScalar: Uint8Array; // derivationToScalar output for this output index
  outputPubkey: Uint8Array; // 32-byte output key from the tx vout
}): Uint8Array | null {
  let outPoint: ReturnType<typeof ed25519.Point.fromBytes>;
  try {
    outPoint = ed25519.Point.fromBytes(args.outputPubkey);
  } catch {
    return null;
  }
  const scalar = leBytesToBigIntMod(args.hsScalar, ED25519_L);
  const hsG = scalar === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(scalar);
  return outPoint.subtract(hsG).toBytes();
}

// Unblind a RingCT v2 (BulletproofPlus) output amount.
//
// Sender encodes `amount` as `encryptedAmount = amount XOR Hs("amount" ||
// sharedSecret)[0..8]` (8 bytes — Monero amounts are uint64 atomic units).
// The recipient recovers it by computing the same hash and XORing.
//
// `encryptedAmount` is exactly 8 bytes (the modern v2 encoding); legacy v1
// 32-byte mask form is not supported here. Returns the amount in atomic
// units (piconero) as a bigint.
export function decodeRctAmount(args: {
  sharedSecret: Uint8Array;
  encryptedAmount: Uint8Array; // 8 bytes, hex-decoded from tx's `ecdhInfo[i].amount`
}): bigint {
  if (args.encryptedAmount.length !== 8) {
    throw new Error("decodeRctAmount: encryptedAmount must be 8 bytes (RingCT v2 encoding)");
  }
  const preimage = new Uint8Array("amount".length + args.sharedSecret.length);
  preimage.set(new TextEncoder().encode("amount"), 0);
  preimage.set(args.sharedSecret, "amount".length);
  const mask = keccak_256(preimage);
  let out = 0n;
  for (let i = 0; i < 8; i += 1) {
    const b = (args.encryptedAmount[i]! ^ mask[i]!) & 0xff;
    out |= BigInt(b) << BigInt(i * 8);
  }
  return out;
}

// Monero's fixed second Pedersen generator H (rct::H in
// monero/src/ringct/rctTypes.h) — the point used for the amount component
// of output commitments: C = mask·G + amount·H. Derived in the reference
// implementation as to_point(keccak(G)); we pin the canonical compressed
// encoding directly.
const MONERO_H_HEX = "8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94";
const MONERO_H = ed25519.Point.fromBytes(hexToBytesInternal(MONERO_H_HEX));

// Recompute the Pedersen commitment a RingCT output MUST carry for a given
// decoded amount:
//   mask = Hs("commitment_mask" || sharedSecret)   (rctOps.cpp:genCommitmentMask
//          — same domain-tag construction as decodeRctAmount's "amount" tag)
//   C'   = mask·G + amount·H
// Monero stores `rct_signatures.outPk[i]` as the ACTUAL commitment point, so
// callers compare C' byte-equal against outPk.
export function computeRctCommitment(args: {
  sharedSecret: Uint8Array; // 32 bytes — deriveSharedSecret output
  amount: bigint; // atomic units (piconero), uint64
}): Uint8Array {
  if (args.amount < 0n) {
    throw new Error("computeRctCommitment: negative amount");
  }
  const tag = new TextEncoder().encode("commitment_mask");
  const preimage = new Uint8Array(tag.length + args.sharedSecret.length);
  preimage.set(tag, 0);
  preimage.set(args.sharedSecret, tag.length);
  const mask = hashToScalar(preimage);
  // mask = 0 is cryptographically unreachable (keccak preimage), but fall
  // back to the identity point rather than letting noble throw on a zero
  // scalar. Same for amount = 0 (a real, if unusual, RingCT amount).
  const maskPart = mask === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(mask);
  const amountScalar = args.amount % ED25519_L;
  const amountPart = amountScalar === 0n ? ed25519.Point.ZERO : MONERO_H.multiply(amountScalar);
  return maskPart.add(amountPart).toBytes();
}

// Verify a decoded RingCT amount against the output's consensus-validated
// Pedersen commitment. The `ecdhInfo` amount field is NOT validated by
// Monero consensus — a malicious payer who knows the tx secret can commit
// ~0 XMR while encoding a large amount in ecdhInfo (fake-deposit attack).
// The commitment IS validated (range proofs + balance check), so a
// byte-equal match of C' = mask·G + amount·H against outPk proves the
// decoded amount is the real on-chain value. Returns false on mismatch or
// malformed input — callers must treat false as "amount 0 / do not credit"
// (wallet2 behavior).
export function verifyRctCommitment(args: {
  sharedSecret: Uint8Array;
  amount: bigint;
  commitment: Uint8Array; // 32 bytes — rct_signatures.outPk[i]
}): boolean {
  if (args.commitment.length !== 32) return false;
  let expected: Uint8Array;
  try {
    expected = computeRctCommitment({ sharedSecret: args.sharedSecret, amount: args.amount });
  } catch {
    return false;
  }
  return constantTimeEqual(expected, args.commitment);
}

// ---- Internal helpers ----

function hexToBytesInternal(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hexToBytesInternal: odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}

function leBytesToBigIntMod(bytes: Uint8Array, modulus: bigint): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    n = (n << 8n) | BigInt(bytes[i]!);
  }
  return n % modulus;
}

function u32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

// Encode a scalar (already reduced mod ℓ) as 32 LE bytes — Monero's
// `ec_scalar` storage format, used by `derivation_to_scalar` and
// downstream amount-decoding.
function scalarToLEBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
