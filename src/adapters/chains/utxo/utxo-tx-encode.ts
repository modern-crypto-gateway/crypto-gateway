// Bitcoin transaction encoding primitives.
//
// Scope: just the bits we need for native-segwit (BIP141) P2WPKH txs:
//   - varint, little-endian uint32/uint64
//   - witness-marked tx serialization (preimage + signed)
//   - BIP143 sighash for P2WPKH inputs
//
// Reference: https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki
//            https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki
//
// We keep this file dependency-light (only @noble/hashes for SHA256). All
// integer / byte fiddling is pure JS so it ships fine on Cloudflare Workers.
import { sha256 } from "@noble/hashes/sha2.js";

// ---- byte / hex helpers ----

export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex: ${hex}`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

export function concatBytes(...arrays: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// SHA256d — Bitcoin's canonical "double SHA256" used everywhere from txid
// computation to BIP143 sighash. Output is always 32 bytes.
export function hash256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

// ---- integer encoding (Bitcoin uses little-endian for almost everything) ----

export function encodeLeUint32(n: number): Uint8Array {
  if (n < 0 || n > 0xffff_ffff) {
    throw new Error(`encodeLeUint32: out of range: ${n}`);
  }
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

export function encodeLeUint64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`encodeLeUint64: out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// Bitcoin's variable-length integer ("compact size"). 1 byte for n<0xfd,
// 3 bytes (0xfd + 2-byte LE) for n<0x10000, 5 bytes for n<2^32, 9 bytes
// otherwise. We don't realistically hit the 9-byte case; throw instead so
// any caller producing implausibly large values surfaces as a bug.
export function encodeVarint(n: number): Uint8Array {
  if (n < 0) throw new Error(`encodeVarint: negative: ${n}`);
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    return new Uint8Array([0xfd, n & 0xff, (n >>> 8) & 0xff]);
  }
  if (n <= 0xffff_ffff) {
    return new Uint8Array([
      0xfe,
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff
    ]);
  }
  throw new Error(`encodeVarint: value exceeds 32-bit cap: ${n}`);
}

// ---- tx structures ----

// One input being spent. `prevTxid` is the funding tx's hash in the
// big-endian display form Bitcoin uses (what you see in block explorers);
// we reverse it on the wire.
export interface UtxoInput {
  readonly prevTxid: string;       // 32-byte hex, big-endian display
  readonly prevVout: number;
  // The pubkey-script of the OUTPUT being spent. For P2WPKH this is
  // 0014<20-byte hash160>. Needed for sighash + final witness construction.
  readonly prevScriptPubkey: string; // hex
  readonly prevValue: bigint;        // value of the spent output, in satoshis
  readonly sequence: number;         // typically 0xffffffff (no RBF)
}

export interface UtxoOutput {
  readonly scriptPubkey: string; // hex
  readonly value: bigint;        // satoshis
}

export interface UnsignedSegwitTx {
  readonly version: number;       // 2
  readonly inputs: readonly UtxoInput[];
  readonly outputs: readonly UtxoOutput[];
  readonly locktime: number;      // 0
}

// Reverses byte order of a hex string. Used because txids are displayed
// big-endian but stored on the wire little-endian.
function reverseHexBytes(hex: string): Uint8Array {
  const fwd = hexToBytes(hex);
  const out = new Uint8Array(fwd.length);
  for (let i = 0; i < fwd.length; i += 1) out[i] = fwd[fwd.length - 1 - i]!;
  return out;
}

// ---- BIP143 sighash for P2WPKH ----
//
// For a P2WPKH input the signed message is:
//   nVersion (4) || hashPrevouts (32) || hashSequence (32) ||
//   outpoint (36) || scriptCode (26) || amount (8) || nSequence (4) ||
//   hashOutputs (32) || nLocktime (4) || sighashType (4)
//
// Where:
//   hashPrevouts = SHA256d(concat each input's outpoint)
//   hashSequence = SHA256d(concat each input's sequence)
//   hashOutputs  = SHA256d(serialize all outputs)
//   scriptCode for P2WPKH = OP_DUP OP_HASH160 <20-byte program> OP_EQUALVERIFY OP_CHECKSIG
//                          = 0x76 0xa9 0x14 <20 bytes> 0x88 0xac
//
// Returns the 32-byte digest the caller will sign with secp256k1.

export const SIGHASH_ALL = 0x01;

export function bip143SighashP2wpkh(
  tx: UnsignedSegwitTx,
  inputIndex: number,
  pubkeyHash160: Uint8Array
): Uint8Array {
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`bip143SighashP2wpkh: inputIndex ${inputIndex} out of range`);
  }
  if (pubkeyHash160.length !== 20) {
    throw new Error(`bip143SighashP2wpkh: pubkeyHash160 must be 20 bytes, got ${pubkeyHash160.length}`);
  }

  // hashPrevouts: each outpoint = reverse(prevTxid) || LE32(prevVout)
  const prevoutsConcat = concatBytes(
    ...tx.inputs.map((i) => concatBytes(reverseHexBytes(i.prevTxid), encodeLeUint32(i.prevVout)))
  );
  const hashPrevouts = hash256(prevoutsConcat);

  // hashSequence: concat each input's nSequence (4-byte LE)
  const sequencesConcat = concatBytes(...tx.inputs.map((i) => encodeLeUint32(i.sequence)));
  const hashSequence = hash256(sequencesConcat);

  // hashOutputs: concat (value || scriptLen varint || script) for each output
  const outputsConcat = concatBytes(
    ...tx.outputs.map((o) => {
      const script = hexToBytes(o.scriptPubkey);
      return concatBytes(encodeLeUint64(o.value), encodeVarint(script.length), script);
    })
  );
  const hashOutputs = hash256(outputsConcat);

  // Outpoint of the input being signed
  const input = tx.inputs[inputIndex]!;
  const outpoint = concatBytes(reverseHexBytes(input.prevTxid), encodeLeUint32(input.prevVout));

  // P2WPKH scriptCode: 19 bytes script preceded by varint(25) — wait, the
  // BIP143 spec inserts the scriptCode bytes directly (no length prefix
  // INSIDE the preimage; the preimage's hashOutputs varint-prefixes its
  // members but the scriptCode segment is its own self-delimited block via
  // a varint-len prefix per BIP143's exact wording: "scriptCode of the
  // input (serialized as scripts inside CTxOuts)"). So we emit
  //   varint(25) || OP_DUP OP_HASH160 0x14 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  const scriptCode = concatBytes(
    new Uint8Array([0x76, 0xa9, 0x14]),
    pubkeyHash160,
    new Uint8Array([0x88, 0xac])
  );
  // 25 bytes of scriptCode, prefixed by varint length (1 byte for 25).
  const scriptCodeWithLen = concatBytes(encodeVarint(scriptCode.length), scriptCode);

  const preimage = concatBytes(
    encodeLeUint32(tx.version),
    hashPrevouts,
    hashSequence,
    outpoint,
    scriptCodeWithLen,
    encodeLeUint64(input.prevValue),
    encodeLeUint32(input.sequence),
    hashOutputs,
    encodeLeUint32(tx.locktime),
    encodeLeUint32(SIGHASH_ALL)
  );
  return hash256(preimage);
}

// ---- DER signature wrapping ----
//
// Witness signature is DER(r,s) || sighashType. r and s are 32-byte
// big-endian; DER wants them as positive integers (prefix 0x00 if MSB set)
// inside SEQUENCE { INTEGER r, INTEGER s }.

export function encodeDerSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
  const rEnc = encodeDerInt(r);
  const sEnc = encodeDerInt(s);
  const seqLen = rEnc.length + sEnc.length;
  return concatBytes(new Uint8Array([0x30, seqLen]), rEnc, sEnc);
}

function encodeDerInt(n: Uint8Array): Uint8Array {
  // Strip leading zero bytes, but keep a leading 0x00 if the next byte's
  // high bit is set (so DER reads it as positive).
  let i = 0;
  while (i < n.length - 1 && n[i] === 0x00) i += 1;
  const stripped = new Uint8Array(n.length - i);
  stripped.set(n.subarray(i));
  const body = (stripped[0]! & 0x80) !== 0 ? concatBytes(new Uint8Array([0x00]), stripped) : stripped;
  return concatBytes(new Uint8Array([0x02, body.length]), body);
}

// ---- final segwit tx serialization ----
//
// Wire format (with witness):
//   version (4 LE)
//   marker (0x00) + flag (0x01)              ← BIP141 segwit marker
//   input_count (varint)
//   inputs: outpoint (36) + script_len=0 (1) + sequence (4)
//   output_count (varint)
//   outputs: value (8 LE) + script_len varint + script
//   per-input witness: stack_size varint + items (each: len varint + data)
//   locktime (4 LE)
//
// The TXID is hash256 of the LEGACY serialization (no marker/flag/witness).

export interface SignedSegwitTx {
  readonly version: number;
  readonly inputs: readonly UtxoInput[];
  readonly outputs: readonly UtxoOutput[];
  // Per-input witness data: array of stack items (signature, pubkey, ...).
  // P2WPKH stack is exactly [sig+sighashType, compressedPubkey] (2 items).
  readonly witnesses: readonly (readonly Uint8Array[])[];
  readonly locktime: number;
}

export function serializeSignedTx(tx: SignedSegwitTx): Uint8Array {
  if (tx.witnesses.length !== tx.inputs.length) {
    throw new Error(
      `serializeSignedTx: witness count ${tx.witnesses.length} != input count ${tx.inputs.length}`
    );
  }

  const inputBytes = concatBytes(
    encodeVarint(tx.inputs.length),
    ...tx.inputs.map((i) =>
      concatBytes(
        reverseHexBytes(i.prevTxid),
        encodeLeUint32(i.prevVout),
        encodeVarint(0), // scriptSig empty (segwit)
        encodeLeUint32(i.sequence)
      )
    )
  );

  const outputBytes = concatBytes(
    encodeVarint(tx.outputs.length),
    ...tx.outputs.map((o) => {
      const script = hexToBytes(o.scriptPubkey);
      return concatBytes(encodeLeUint64(o.value), encodeVarint(script.length), script);
    })
  );

  const witnessBytes = concatBytes(
    ...tx.witnesses.map((stack) =>
      concatBytes(
        encodeVarint(stack.length),
        ...stack.map((item) => concatBytes(encodeVarint(item.length), item))
      )
    )
  );

  return concatBytes(
    encodeLeUint32(tx.version),
    new Uint8Array([0x00, 0x01]), // marker + flag
    inputBytes,
    outputBytes,
    witnessBytes,
    encodeLeUint32(tx.locktime)
  );
}

// TXID computation: hash256 of the legacy (non-segwit) serialization. This
// is what users / explorers see as the "transaction id" (vs the witness
// txid `wtxid` which includes the witness).
export function computeTxid(tx: SignedSegwitTx): string {
  const legacyInputs = concatBytes(
    encodeVarint(tx.inputs.length),
    ...tx.inputs.map((i) =>
      concatBytes(
        reverseHexBytes(i.prevTxid),
        encodeLeUint32(i.prevVout),
        encodeVarint(0),
        encodeLeUint32(i.sequence)
      )
    )
  );
  const legacyOutputs = concatBytes(
    encodeVarint(tx.outputs.length),
    ...tx.outputs.map((o) => {
      const script = hexToBytes(o.scriptPubkey);
      return concatBytes(encodeLeUint64(o.value), encodeVarint(script.length), script);
    })
  );
  const legacy = concatBytes(
    encodeLeUint32(tx.version),
    legacyInputs,
    legacyOutputs,
    encodeLeUint32(tx.locktime)
  );
  // txid is displayed reversed (big-endian).
  const digest = hash256(legacy);
  const reversed = new Uint8Array(digest.length);
  for (let i = 0; i < digest.length; i += 1) reversed[i] = digest[digest.length - 1 - i]!;
  return bytesToHex(reversed);
}
