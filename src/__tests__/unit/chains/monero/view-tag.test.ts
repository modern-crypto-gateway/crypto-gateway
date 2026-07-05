import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  computeRctCommitment,
  derivationToScalar,
  deriveKeyDerivation,
  deriveSharedSecret,
  deriveSubaddress,
  deriveViewTag,
  encodeAddress,
  expectedOutputPubkey,
  outputToSubaddressSpendPub,
  parseAddress
} from "../../../../adapters/chains/monero/monero-crypto.js";
import {
  buildMoneroScanContext,
  matchMoneroTxOutputs,
  MONERO_UNKNOWN_SENDER
} from "../../../../adapters/chains/monero/monero-chain.adapter.js";
import { MONERO_MAINNET_CONFIG } from "../../../../adapters/chains/monero/monero-config.js";
import type {
  MoneroParsedTx,
  MoneroTxOutput
} from "../../../../adapters/chains/monero/monero-rpc.js";

// View-tag prefilter tests — the split scan pipeline
// (deriveKeyDerivation → derivationToScalar / deriveViewTag →
// outputToSubaddressSpendPub) plus the pure matcher that consumes it.
//
// Pure crypto + matcher only: no bootTestApp, no DB, no RPC stubs. The
// matcher is deliberately pure (see the "Shared view-key matcher" comment in
// monero-chain.adapter.ts) precisely so its cryptographic behavior can be
// pinned here without an app boot.
//
// What these tests protect:
//   - The refactor didn't change bytes: composed helpers must equal the
//     legacy deriveSharedSecret they were split from.
//   - Tag semantics: a correct tag matches, a wrong tag SKIPS the output
//     (wallet2 behavior — consensus doesn't validate tags, so a sender who
//     writes a garbage tag hides the output from every scanning wallet,
//     including the recipient's own), a missing tag (pre-v15) bypasses the
//     prefilter, and a false-positive tag still fails the full EC check.
//   - Transfer stamping: height/confirmation/onchainTime fallbacks for both
//     mined and pool txs.

const ED25519_L = ed25519.Point.Fn.ORDER;

// ---- Deterministic key material (mirrors makeWallet in
// monero-inbound.test.ts — replicated locally because unit tests must not
// import integration helpers or boot the app) ----

function leBytesToBigIntMod(bytes: Uint8Array, modulus: bigint): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]!);
  return n % modulus;
}

function scalarToLEBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fixed-seed scalar in [1, ℓ) — deterministic so failures always reproduce.
// (keccak of a fixed string is never 0 mod ℓ in practice; the max(1) guard
// just keeps noble from ever seeing a zero scalar.)
function scalarFromSeed(seed: string): bigint {
  const s = leBytesToBigIntMod(keccak_256(new TextEncoder().encode(seed)), ED25519_L);
  return s === 0n ? 1n : s;
}

function makeWallet(seedSuffix: string): {
  primaryAddress: string;
  viewKey: Uint8Array;
  primarySpendPub: Uint8Array;
} {
  const spendScalar = scalarFromSeed(`monero-vt-spend-${seedSuffix}`);
  const viewScalar = scalarFromSeed(`monero-vt-view-${seedSuffix}`);
  const viewKey = scalarToLEBytes32(viewScalar);
  const primarySpendPub = ed25519.Point.BASE.multiply(spendScalar).toBytes();
  const publicViewKey = ed25519.Point.BASE.multiply(viewScalar).toBytes();
  const primaryAddress = encodeAddress({
    network: "mainnet",
    isSubaddress: false,
    publicSpendKey: primarySpendPub,
    publicViewKey
  });
  return { primaryAddress, viewKey, primarySpendPub };
}

// Independent re-implementation of Monero's derive_view_tag:
//   keccak_256("view_tag" || derivation || varint(i))[0]
// Salt bytes and the LEB128 varint are inlined (NOT the production
// encodeVarint) so a shared bug in monero-crypto.ts can't cancel out and
// make the comparison circular.
function independentViewTag(derivation: Uint8Array, outputIndex: number): number {
  const salt = [0x76, 0x69, 0x65, 0x77, 0x5f, 0x74, 0x61, 0x67]; // "view_tag", 8 ascii bytes, no NUL
  const varint: number[] = [];
  let v = outputIndex;
  while (v >= 0x80) {
    varint.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  varint.push(v);
  return keccak_256(new Uint8Array([...salt, ...derivation, ...varint]))[0]!;
}

// ---- Sender-side output synthesis (mirrors "Synthesize an on-chain tx
// output" in monero-inbound.test.ts) ----
//
// For a subaddress recipient the sender's tx pubkey is r·D (NOT r·G):
//   receiver derivation = 8·a·(r·D) = 8r·(a·D) = 8r·C = sender derivation,
// so both sides reach the same point without additional pubkeys. The output
// sits at index 0 of the tx: s = Hs(derivation || varint(0)), K_out = s·G + D,
// encryptedAmount = amount XOR keccak("amount" || s)[0..8], commitment
// C' = Hs("commitment_mask" || s)·G + amount·H. The view tag is stamped from
// the SENDER-side derivation via the independent implementation — exactly
// what a real wallet writes on-chain, and non-circular with the receiver
// path under test.
function synthesizePayment(args: {
  subaddress: string;
  amount: bigint;
  rSeed: string;
}): { txPubkeyHex: string; correctViewTag: number; output: MoneroTxOutput } {
  const subParsed = parseAddress(args.subaddress);
  const r = scalarFromSeed(args.rSeed);
  const D = ed25519.Point.fromBytes(subParsed.publicSpendKey);
  const C = ed25519.Point.fromBytes(subParsed.publicViewKey);
  const txPubkeyHex = bytesToHex(D.multiply(r).toBytes());
  const senderDerivation = C.multiply(r).multiply(8n).toBytes();

  // s = Hs(derivation || varint(0)); varint(0) is the single byte 0x00.
  const sPre = new Uint8Array(senderDerivation.length + 1);
  sPre.set(senderDerivation, 0);
  sPre[senderDerivation.length] = 0;
  const sBytes = scalarToLEBytes32(leBytesToBigIntMod(keccak_256(sPre), ED25519_L));
  const s = leBytesToBigIntMod(sBytes, ED25519_L);
  const Kout = ed25519.Point.BASE.multiply(s).add(D).toBytes();

  // encryptedAmount = amount XOR keccak("amount" || s)[0..8] (RingCT v2).
  const aPre = new Uint8Array("amount".length + sBytes.length);
  aPre.set(new TextEncoder().encode("amount"), 0);
  aPre.set(sBytes, "amount".length);
  const mask = keccak_256(aPre);
  const encrypted = new Uint8Array(8);
  let v = args.amount;
  for (let i = 0; i < 8; i += 1) {
    encrypted[i] = (Number(v & 0xffn) ^ mask[i]!) & 0xff;
    v >>= 8n;
  }

  const correctViewTag = independentViewTag(senderDerivation, 0);
  return {
    txPubkeyHex,
    correctViewTag,
    output: {
      publicKey: bytesToHex(Kout),
      encryptedAmount: bytesToHex(encrypted),
      // Real commitment for the real amount — the matcher refuses to credit
      // outputs whose commitment doesn't match the decoded ecdhInfo amount.
      commitment: bytesToHex(
        computeRctCommitment({ sharedSecret: sBytes, amount: args.amount })
      ),
      viewTag: correctViewTag
    }
  };
}

// Assemble a MoneroParsedTx around synthesized outputs. Defaults model the
// common mined non-coinbase payment; tests override single fields to probe
// each matcher guard in isolation.
function makeTx(args: {
  txPubkeyHex: string;
  outputs: readonly MoneroTxOutput[];
  blockHeight?: number | null;
  isCoinbase?: boolean;
  unlockTime?: number;
}): MoneroParsedTx {
  return {
    txHash: "cd".repeat(32),
    blockHeight: args.blockHeight ?? null,
    txPubkey: args.txPubkeyHex,
    additionalPubkeys: [],
    outputs: args.outputs,
    isCoinbase: args.isCoinbase ?? false,
    unlockTime: args.unlockTime ?? 0
  };
}

const SEEN_AT = new Date("2026-07-05T00:00:00Z");
const AMOUNT = 150000000000n; // 0.15 XMR (12 decimals)

// One wallet + watched subaddress + synthesized payment shared by all the
// matcher tests — each case perturbs exactly one field, so a pass/fail
// difference is attributable to that field alone.
function matcherFixture() {
  const w = makeWallet("matcher");
  const sub = deriveSubaddress({
    network: "mainnet",
    viewKeySecret: w.viewKey,
    primarySpendPub: w.primarySpendPub,
    account: 0,
    index: 1
  });
  const payment = synthesizePayment({ subaddress: sub, amount: AMOUNT, rSeed: "matcher-r" });
  const ctx = buildMoneroScanContext({
    chainId: MONERO_MAINNET_CONFIG.chainId,
    viewKey: w.viewKey,
    addresses: [sub]
  });
  return { w, sub, payment, ctx };
}

describe("deriveKeyDerivation + derivationToScalar (split pipeline)", () => {
  it("composition equals the legacy deriveSharedSecret byte-for-byte", () => {
    // Indices straddle the varint width change (1 byte through 127, 2 bytes
    // from 128) — a varint bug in either half would diverge at 200 only.
    const combos = [
      { seed: "compose-a", outputIndex: 0 },
      { seed: "compose-a", outputIndex: 1 },
      { seed: "compose-a", outputIndex: 200 },
      { seed: "compose-b", outputIndex: 0 },
      { seed: "compose-b", outputIndex: 200 }
    ] as const;
    for (const { seed, outputIndex } of combos) {
      const w = makeWallet(seed);
      const txPubkey = ed25519.Point.BASE.multiply(scalarFromSeed(`${seed}-r`)).toBytes();
      // The whole point of the split: one derivation per tx pubkey, reused
      // across output indices.
      const derivation = deriveKeyDerivation({ viewKeySecret: w.viewKey, txPubkey });
      const composed = derivationToScalar({ derivation, outputIndex });
      const legacy = deriveSharedSecret({ viewKeySecret: w.viewKey, txPubkey, outputIndex });
      expect(bytesToHex(composed)).toBe(bytesToHex(legacy));
    }
  });
});

describe("deriveViewTag", () => {
  it("matches an independent sender-side construction across the varint boundary", () => {
    const w = makeWallet("viewtag");
    const txPubkey = ed25519.Point.BASE.multiply(scalarFromSeed("viewtag-r")).toBytes();
    const derivation = deriveKeyDerivation({ viewKeySecret: w.viewKey, txPubkey });
    // 127/128 straddle the 1→2-byte varint switch; 300 needs the 2-byte form
    // with a non-trivial high group. A salt or varint bug flips SOME byte-0
    // in this set (five independent keccak evaluations).
    for (const outputIndex of [0, 1, 127, 128, 300]) {
      expect(deriveViewTag({ derivation, outputIndex })).toBe(
        independentViewTag(derivation, outputIndex)
      );
    }
  });
});

describe("outputToSubaddressSpendPub", () => {
  it("inverts expectedOutputPubkey — recovers the subaddress spend pub byte-for-byte", () => {
    const sBytes = scalarToLEBytes32(scalarFromSeed("invert-s"));
    const D = ed25519.Point.BASE.multiply(scalarFromSeed("invert-d")).toBytes();
    // Forward: P = s·G + D (what a sender writes on-chain)…
    const P = expectedOutputPubkey({ sharedSecret: sBytes, subaddressSpendPub: D });
    // …inverse: D' = P − s·G (what the scanner looks up in its watched map).
    const recovered = outputToSubaddressSpendPub({ hsScalar: sBytes, outputPubkey: P });
    expect(recovered).not.toBeNull();
    expect(bytesToHex(recovered!)).toBe(bytesToHex(D));
  });

  it("returns null when the output pubkey doesn't decode to a curve point", () => {
    const sBytes = scalarToLEBytes32(scalarFromSeed("nonpoint-s"));
    const D = ed25519.Point.BASE.multiply(scalarFromSeed("nonpoint-d")).toBytes();
    const P = expectedOutputPubkey({ sharedSecret: sBytes, subaddressSpendPub: D });
    // Corrupt P's low byte until noble refuses to decode it. Roughly half of
    // all y-values have no matching x on the curve, so the search terminates
    // almost immediately — and it's fully deterministic for a fixed P, unlike
    // a single blind byte-flip (which lands on a DIFFERENT valid point ~50%
    // of the time and would make the test flaky-by-construction).
    let bad: Uint8Array | null = null;
    for (let xor = 1; xor < 256 && bad === null; xor += 1) {
      const cand = P.slice();
      cand[0] = cand[0]! ^ xor;
      try {
        ed25519.Point.fromBytes(cand);
      } catch {
        bad = cand;
      }
    }
    expect(bad).not.toBeNull(); // sanity: a non-point exists among 255 corruptions
    expect(outputToSubaddressSpendPub({ hsScalar: sBytes, outputPubkey: bad! })).toBeNull();
  });
});

describe("matchMoneroTxOutputs — view-tag prefilter", () => {
  it("detects a payment whose output carries the correct view tag", () => {
    const { sub, payment, ctx } = matcherFixture();
    const tx = makeTx({ txPubkeyHex: payment.txPubkeyHex, outputs: [payment.output] });
    const transfers = matchMoneroTxOutputs(ctx, tx, {
      fallbackBlockHeight: 105,
      tipHeight: 110,
      blockTimestampSec: 1700000000,
      seenAt: SEEN_AT
    });
    expect(transfers).toHaveLength(1);
    const t = transfers[0]!;
    expect(t.toAddress).toBe(sub);
    expect(t.amountRaw).toBe(AMOUNT.toString());
    expect(t.token).toBe("XMR");
    expect(t.txHash).toBe(tx.txHash);
    expect(t.logIndex).toBe(0);
    // tx.blockHeight is null here, so the transfer must be stamped from the
    // caller-supplied fallback (the block the walk fetched the tx from).
    expect(t.blockNumber).toBe(105);
    expect(t.confirmations).toBe(5); // tip 110 − height 105
    expect(t.onchainTime).toEqual(new Date(1700000000000));
    expect(t.fromAddress).toBe(MONERO_UNKNOWN_SENDER);
    expect(t.seenAt).toBe(SEEN_AT);
  });

  it("returns [] when the view tag byte is flipped (prefilter skips the output)", () => {
    const { payment, ctx } = matcherFixture();
    // Consensus does NOT validate view tags — a sender who writes a wrong
    // tag hides the output from every scanning wallet (wallet2 included, and
    // the recipient's own). Skipping is therefore correct, not a false
    // negative: such an output is unfindable by ANY tag-honoring scanner.
    const corrupted: MoneroTxOutput = {
      ...payment.output,
      viewTag: payment.correctViewTag ^ 0x01
    };
    const tx = makeTx({ txPubkeyHex: payment.txPubkeyHex, outputs: [corrupted] });
    expect(
      matchMoneroTxOutputs(ctx, tx, {
        fallbackBlockHeight: 105,
        tipHeight: 110,
        blockTimestampSec: 1700000000,
        seenAt: SEEN_AT
      })
    ).toEqual([]);
  });

  it("still detects the payment when viewTag is null (pre-v15 output, prefilter bypassed)", () => {
    const { sub, payment, ctx } = matcherFixture();
    const untagged: MoneroTxOutput = { ...payment.output, viewTag: null };
    const tx = makeTx({ txPubkeyHex: payment.txPubkeyHex, outputs: [untagged] });
    const transfers = matchMoneroTxOutputs(ctx, tx, {
      fallbackBlockHeight: 105,
      tipHeight: 110,
      blockTimestampSec: 1700000000,
      seenAt: SEEN_AT
    });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.toAddress).toBe(sub);
    expect(transfers[0]!.amountRaw).toBe(AMOUNT.toString());
  });

  it("rejects a foreign output whose tag false-positives through the prefilter", () => {
    // The ~1/256 case: a stranger's output whose on-chain tag happens to
    // equal the byte OUR derivation predicts. The prefilter passes it
    // through, and the full EC check (P − Hs·G not in the watched map) must
    // be what rejects it — this test fails if the matcher ever starts
    // trusting the tag as a positive signal instead of a skip-filter.
    const w = makeWallet("false-positive");
    const sub = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 1
    });
    const ctx = buildMoneroScanContext({
      chainId: MONERO_MAINNET_CONFIG.chainId,
      viewKey: w.viewKey,
      addresses: [sub]
    });
    const txPubkey = ed25519.Point.BASE.multiply(scalarFromSeed("false-positive-r")).toBytes();
    // A valid curve point unrelated to our subaddress — someone else's output.
    const foreignOutputPub = ed25519.Point.BASE
      .multiply(scalarFromSeed("false-positive-out"))
      .toBytes();
    // Stamp exactly the tag our receiver-side derivation predicts for index 0.
    const recvDerivation = deriveKeyDerivation({ viewKeySecret: w.viewKey, txPubkey });
    const output: MoneroTxOutput = {
      publicKey: bytesToHex(foreignOutputPub),
      // Never reached — the spend-pub lookup misses before amount decoding —
      // but keep the shapes valid so a future reorder doesn't throw instead
      // of rejecting.
      encryptedAmount: "00".repeat(8),
      commitment: "00".repeat(32),
      viewTag: deriveViewTag({ derivation: recvDerivation, outputIndex: 0 })
    };
    const tx = makeTx({ txPubkeyHex: bytesToHex(txPubkey), outputs: [output] });
    expect(
      matchMoneroTxOutputs(ctx, tx, {
        fallbackBlockHeight: 105,
        tipHeight: 110,
        blockTimestampSec: 1700000000,
        seenAt: SEEN_AT
      })
    ).toEqual([]);
  });

  it("skips time-locked and coinbase txs even when the output would otherwise match", () => {
    const { payment, ctx } = matcherFixture();
    const matchArgs = {
      fallbackBlockHeight: 105,
      tipHeight: 110,
      blockTimestampSec: 1700000000,
      seenAt: SEEN_AT
    };
    // Sanity first: the identical tx WITH the guards off matches — proving
    // the []s below come from the guards, not a broken synthesis.
    const clean = makeTx({ txPubkeyHex: payment.txPubkeyHex, outputs: [payment.output] });
    expect(matchMoneroTxOutputs(ctx, clean, matchArgs)).toHaveLength(1);
    // unlock_time delays spendability of EVERY output — crediting one would
    // show the merchant a confirmed deposit they can't spend. Fail closed.
    const locked = makeTx({
      txPubkeyHex: payment.txPubkeyHex,
      outputs: [payment.output],
      unlockTime: 500_000_100
    });
    expect(matchMoneroTxOutputs(ctx, locked, matchArgs)).toEqual([]);
    // Coinbase outputs never pay a view-key holder.
    const coinbase = makeTx({
      txPubkeyHex: payment.txPubkeyHex,
      outputs: [payment.output],
      isCoinbase: true
    });
    expect(matchMoneroTxOutputs(ctx, coinbase, matchArgs)).toEqual([]);
  });

  it("stamps pool txs (no height anywhere) with blockNumber null / confirmations 0 / onchainTime null", () => {
    const { sub, payment, ctx } = matcherFixture();
    // Pool shape: tx not mined (blockHeight null) AND the caller has no
    // fallback or tip — the txpool watcher's instant-detection pass.
    const tx = makeTx({ txPubkeyHex: payment.txPubkeyHex, outputs: [payment.output] });
    const transfers = matchMoneroTxOutputs(ctx, tx, {
      fallbackBlockHeight: null,
      tipHeight: null,
      blockTimestampSec: null,
      seenAt: SEEN_AT
    });
    expect(transfers).toHaveLength(1);
    const t = transfers[0]!;
    expect(t.toAddress).toBe(sub);
    expect(t.blockNumber).toBeNull();
    expect(t.confirmations).toBe(0);
    expect(t.onchainTime).toBeNull();
  });
});
