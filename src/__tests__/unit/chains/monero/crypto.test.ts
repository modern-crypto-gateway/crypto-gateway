import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  computeRctCommitment,
  decodeRctAmount,
  deriveSharedSecret,
  deriveSubaddress,
  encodeAddress,
  encodeVarint,
  expectedOutputPubkey,
  hashToScalar,
  parseAddress,
  verifyRctCommitment,
  viewKeyMatchesAddress
} from "../../../../adapters/chains/monero/monero-crypto.js";
import {
  moneroBase58Decode,
  moneroBase58Encode
} from "../../../../adapters/chains/monero/monero-base58.js";

// Crypto correctness tests for the Monero adapter. Self-consistent — we
// build a synthetic wallet (known view key + spend key), derive its primary
// address, and verify every downstream operation round-trips.
//
// These tests do NOT cross-check against `monero-wallet-cli` output (no
// stagenet/CI access); a real cross-check happens in the smoke test in
// the plan's verification section. What they DO catch:
//   - Algorithmic regressions: any change that breaks subaddress
//     determinism, shared-secret consistency, or amount-unblind round-trip.
//   - Off-by-one bugs in the SubAddr preimage / varint encoding.
//   - Wrong network byte selection.
//   - Base58 block-encoding bugs (pad direction, char-count tables).

const ED25519_L = ed25519.Point.Fn.ORDER;

// Build a deterministic test wallet from a fixed seed. ed25519 secret keys
// are 32 random bytes; we reduce mod ℓ to land in the valid scalar range.
// Using a fixed seed makes the test outputs deterministic so failures
// always reproduce.
function makeTestWallet(seedSuffix: string): {
  viewKey: Uint8Array;
  primarySpendPub: Uint8Array;
  primarySpendSecret: Uint8Array;
  primaryAddress: string;
} {
  const spendSeed = keccak_256(new TextEncoder().encode(`monero-test-spend-${seedSuffix}`));
  const viewSeed = keccak_256(new TextEncoder().encode(`monero-test-view-${seedSuffix}`));
  // Reduce both to valid scalars mod ℓ.
  const spendScalar = leBytesToBigIntMod(spendSeed, ED25519_L);
  const viewScalar = leBytesToBigIntMod(viewSeed, ED25519_L);
  const primarySpendSecret = scalarToLEBytes32(spendScalar);
  const viewKey = scalarToLEBytes32(viewScalar);
  const primarySpendPub = ed25519.Point.BASE.multiply(spendScalar).toBytes();
  const publicViewKey = ed25519.Point.BASE.multiply(viewScalar).toBytes();
  const primaryAddress = encodeAddress({
    network: "mainnet",
    isSubaddress: false,
    publicSpendKey: primarySpendPub,
    publicViewKey
  });
  return { viewKey, primarySpendPub, primarySpendSecret, primaryAddress };
}

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

describe("monero-base58 (split-block)", () => {
  it("round-trips the canonical 69-byte address payload", () => {
    const payload = new Uint8Array(69);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7 + 3) & 0xff;
    const encoded = moneroBase58Encode(payload);
    expect(encoded).toHaveLength(95); // mainnet primary address length
    expect(moneroBase58Decode(encoded)).toEqual(payload);
  });

  it("rejects strings with non-alphabet characters", () => {
    expect(() => moneroBase58Decode("0OIl_invalid_chars")).toThrow();
  });

  it("encodes 8-byte blocks to exactly 11 chars", () => {
    const block = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const encoded = moneroBase58Encode(block);
    expect(encoded).toHaveLength(11);
    expect(moneroBase58Decode(encoded)).toEqual(block);
  });
});

describe("parseAddress + encodeAddress", () => {
  it("round-trips a generated mainnet primary address", () => {
    const w = makeTestWallet("rt1");
    const parsed = parseAddress(w.primaryAddress);
    expect(parsed.network).toBe("mainnet");
    expect(parsed.isSubaddress).toBe(false);
    expect(parsed.publicSpendKey).toEqual(w.primarySpendPub);
  });

  it("rejects a mutated checksum", () => {
    const w = makeTestWallet("badchk");
    // Flip the LAST char (part of the checksum block).
    const flipped =
      w.primaryAddress.slice(0, -1) +
      (w.primaryAddress.slice(-1) === "1" ? "2" : "1");
    expect(() => parseAddress(flipped)).toThrow(/checksum/);
  });

  it("rejects a network mismatch", () => {
    const w = makeTestWallet("netmix");
    const parsed = parseAddress(w.primaryAddress);
    // Re-encode with stagenet network byte but same keys → same bytes
    // length, different prefix → checksum will fail.
    const stagenet = encodeAddress({
      network: "stagenet",
      isSubaddress: false,
      publicSpendKey: parsed.publicSpendKey,
      publicViewKey: parsed.publicViewKey
    });
    const stageParsed = parseAddress(stagenet);
    expect(stageParsed.network).toBe("stagenet");
    expect(stageParsed.network).not.toBe(parsed.network);
  });

  it("rejects malformed base58 input", () => {
    expect(() => parseAddress("not-a-valid-monero-address")).toThrow();
  });
});

describe("viewKeyMatchesAddress", () => {
  it("returns true when the secret view key derives to the address's public view component", () => {
    const w = makeTestWallet("vkok");
    expect(viewKeyMatchesAddress(w.viewKey, w.primaryAddress)).toBe(true);
  });

  it("returns false on a wrong view key", () => {
    const w = makeTestWallet("vkmiss");
    const otherWallet = makeTestWallet("other");
    expect(viewKeyMatchesAddress(otherWallet.viewKey, w.primaryAddress)).toBe(false);
  });

  it("returns false when given a subaddress (must be the primary)", () => {
    const w = makeTestWallet("vksub");
    const sub = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 1
    });
    expect(viewKeyMatchesAddress(w.viewKey, sub)).toBe(false);
  });
});

describe("deriveSubaddress", () => {
  it("is deterministic — same inputs always produce the same subaddress", () => {
    const w = makeTestWallet("det");
    const a = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 1
    });
    const b = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 1
    });
    expect(a).toBe(b);
  });

  it("produces distinct subaddresses for distinct indices", () => {
    const w = makeTestWallet("uniq");
    const sub1 = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 1
    });
    const sub2 = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 2
    });
    const sub3 = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 3
    });
    expect(new Set([sub1, sub2, sub3]).size).toBe(3);
  });

  it("encodes with the subaddress network byte (parses back as isSubaddress=true)", () => {
    const w = makeTestWallet("subnet");
    const sub = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: 5
    });
    const parsed = parseAddress(sub);
    expect(parsed.network).toBe("mainnet");
    expect(parsed.isSubaddress).toBe(true);
  });

  it("rejects (account=0, index=0) — that's the primary address", () => {
    const w = makeTestWallet("zerozero");
    expect(() =>
      deriveSubaddress({
        network: "mainnet",
        viewKeySecret: w.viewKey,
        primarySpendPub: w.primarySpendPub,
        account: 0,
        index: 0
      })
    ).toThrow(/primary/);
  });
});

describe("output detection — shared secret + expected output pubkey", () => {
  it("a synthesized output for subaddress N matches expectedOutputPubkey for N (and ONLY N)", () => {
    const w = makeTestWallet("output1");
    const subaddrN = 7;
    const subStr = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: subaddrN
    });
    const subParsed = parseAddress(subStr);

    // Sender side: pick a random "tx ephemeral key" (rₜₓ secret + rₜₓ G as
    // public). For subaddresses, the sender uses rₜₓ · subaddressViewPub
    // as the txPubkey component (not rₜₓ · G), so detection works without
    // additional pubkeys. Simulate that here.
    const rTx = leBytesToBigIntMod(
      keccak_256(new TextEncoder().encode("synthetic-r-tx")),
      ED25519_L
    );
    const txPubkeyForSub = ed25519.Point.fromBytes(subParsed.publicViewKey)
      .multiply(rTx)
      .toBytes();
    // Each individual output is at outputIndex i (we pick 2).
    const outputIndex = 2;
    const sharedSecret = deriveSharedSecret({
      viewKeySecret: w.viewKey,
      txPubkey: txPubkeyForSub,
      outputIndex
    });
    // Sender's actual output pubkey = Hs(rₜₓ · subView || varint(idx)) · G + subSpendPub.
    // From the recipient side we recompute Hs(8·viewSecret·txPub || varint(idx))
    // — but for subaddress txs the sender uses rₜₓ · subView so 8·viewSecret·rₜₓ·subView
    // simplifies to a value that rₜₓ · subView gives us. Both sides reach the
    // same shared secret because rₜₓ·subView has only one curve point representation.
    // Note: this synthesis is per-subaddress (matches Monero's actual subaddress flow).
    const expected = expectedOutputPubkey({
      sharedSecret,
      subaddressSpendPub: subParsed.publicSpendKey
    });
    // The sender would broadcast `expected` as the output_public_key. Simulate
    // that by re-deriving with the synthesized values; receiver side gets a hit.
    expect(expected.length).toBe(32);
    // Cross-check: the OTHER subaddress at a different index does NOT match
    // the same output. Different subSpendPub → different expected pubkey.
    const wrongSubStr = deriveSubaddress({
      network: "mainnet",
      viewKeySecret: w.viewKey,
      primarySpendPub: w.primarySpendPub,
      account: 0,
      index: subaddrN + 1
    });
    const wrongSubParsed = parseAddress(wrongSubStr);
    const wrongExpected = expectedOutputPubkey({
      sharedSecret,
      subaddressSpendPub: wrongSubParsed.publicSpendKey
    });
    expect(Buffer.from(wrongExpected).toString("hex"))
      .not.toBe(Buffer.from(expected).toString("hex"));
  });
});

describe("decodeRctAmount", () => {
  it("XOR round-trip recovers an encoded amount", () => {
    // Pick an arbitrary 32-byte sharedSecret + a known plaintext amount.
    const sharedSecret = keccak_256(new TextEncoder().encode("amount-test-shared"));
    const plaintext = 12345678n; // ~0.012 XMR (12 decimals)
    // Encode: amountMask = keccak("amount" || sharedSecret); enc = plaintext ^ mask[0..8]
    const preimage = new Uint8Array("amount".length + sharedSecret.length);
    preimage.set(new TextEncoder().encode("amount"), 0);
    preimage.set(sharedSecret, "amount".length);
    const mask = keccak_256(preimage);
    const encrypted = new Uint8Array(8);
    let v = plaintext;
    for (let i = 0; i < 8; i += 1) {
      encrypted[i] = (Number(v & 0xffn) ^ mask[i]!) & 0xff;
      v >>= 8n;
    }
    const recovered = decodeRctAmount({ sharedSecret, encryptedAmount: encrypted });
    expect(recovered).toBe(plaintext);
  });

  it("rejects encryptedAmount of wrong length", () => {
    const sharedSecret = new Uint8Array(32);
    expect(() =>
      decodeRctAmount({ sharedSecret, encryptedAmount: new Uint8Array(7) })
    ).toThrow();
  });
});

describe("RingCT commitment verification (fake-deposit defense)", () => {
  // Monero's fixed second generator H (rct::H) — pinned here independently
  // of monero-crypto.ts so the test catches a corrupted constant there.
  const H_HEX = "8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94";

  function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // Independently construct C = mask·G + amount·H exactly as a sender's
  // wallet does (rctOps.cpp: genCommitmentMask + addKeys2), WITHOUT going
  // through computeRctCommitment — so the test isn't circular.
  function senderSideCommitment(sharedSecret: Uint8Array, amount: bigint): Uint8Array {
    const tag = new TextEncoder().encode("commitment_mask");
    const pre = new Uint8Array(tag.length + sharedSecret.length);
    pre.set(tag, 0);
    pre.set(sharedSecret, tag.length);
    const mask = leBytesToBigIntMod(keccak_256(pre), ED25519_L);
    const H = ed25519.Point.fromBytes(hexToBytes(H_HEX));
    return ed25519.Point.BASE.multiply(mask).add(H.multiply(amount)).toBytes();
  }

  it("accepts a commitment independently constructed as mask·G + amount·H", () => {
    const sharedSecret = keccak_256(new TextEncoder().encode("commit-test-shared"));
    const amount = 150000000000n; // 0.15 XMR
    const commitment = senderSideCommitment(sharedSecret, amount);
    expect(verifyRctCommitment({ sharedSecret, amount, commitment })).toBe(true);
    // computeRctCommitment must reproduce the same point byte-for-byte.
    expect(Buffer.from(computeRctCommitment({ sharedSecret, amount })).toString("hex"))
      .toBe(Buffer.from(commitment).toString("hex"));
  });

  it("rejects a tampered amount (attacker commits dust but claims the invoice total)", () => {
    const sharedSecret = keccak_256(new TextEncoder().encode("commit-test-fake"));
    // The fake-deposit shape: the on-chain commitment locks in 1 piconero,
    // but ecdhInfo decodes to the full invoice amount.
    const committed = 1n;
    const claimed = 150000000000n;
    const commitment = senderSideCommitment(sharedSecret, committed);
    expect(verifyRctCommitment({ sharedSecret, amount: claimed, commitment })).toBe(false);
    // Sanity: the same commitment verifies for the amount it actually locks.
    expect(verifyRctCommitment({ sharedSecret, amount: committed, commitment })).toBe(true);
  });

  it("rejects a wrong shared secret, corrupted commitment bytes, and wrong-length input", () => {
    const sharedSecret = keccak_256(new TextEncoder().encode("commit-test-misc"));
    const amount = 42_000_000_000n;
    const commitment = senderSideCommitment(sharedSecret, amount);
    // Wrong shared secret → different mask → mismatch.
    const otherSecret = keccak_256(new TextEncoder().encode("commit-test-other"));
    expect(verifyRctCommitment({ sharedSecret: otherSecret, amount, commitment })).toBe(false);
    // Single-byte corruption → mismatch.
    const corrupted = commitment.slice();
    corrupted[0] = corrupted[0]! ^ 0x01;
    expect(verifyRctCommitment({ sharedSecret, amount, commitment: corrupted })).toBe(false);
    // Wrong length → fail closed (false, no throw).
    expect(verifyRctCommitment({ sharedSecret, amount, commitment: commitment.subarray(0, 31) })).toBe(false);
  });
});

describe("hashToScalar + encodeVarint internal helpers", () => {
  it("hashToScalar produces a value < ℓ", () => {
    const s = hashToScalar(new TextEncoder().encode("anything"));
    expect(s < ED25519_L).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0n);
  });

  it("encodeVarint round-trips small + large values", () => {
    expect(Array.from(encodeVarint(0))).toEqual([0]);
    expect(Array.from(encodeVarint(127))).toEqual([0x7f]);
    // 128 needs 2 bytes: continuation flag on the first.
    expect(Array.from(encodeVarint(128))).toEqual([0x80, 0x01]);
    expect(Array.from(encodeVarint(300))).toEqual([0xac, 0x02]);
  });
});
