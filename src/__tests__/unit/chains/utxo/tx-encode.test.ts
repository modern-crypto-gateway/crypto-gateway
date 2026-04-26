import { describe, expect, it } from "vitest";
import {
  bip143SighashP2wpkh,
  bytesToHex,
  computeTxid,
  encodeDerSignature,
  encodeLeUint32,
  encodeLeUint64,
  encodeVarint,
  hash256,
  hexToBytes,
  serializeSignedTx,
  type SignedSegwitTx,
  type UnsignedSegwitTx
} from "../../../../adapters/chains/utxo/utxo-tx-encode.js";

describe("integer + varint encoding", () => {
  it("encodes uint32 little-endian", () => {
    expect(bytesToHex(encodeLeUint32(0))).toBe("00000000");
    expect(bytesToHex(encodeLeUint32(1))).toBe("01000000");
    expect(bytesToHex(encodeLeUint32(0xdeadbeef))).toBe("efbeadde");
  });

  it("encodes uint64 little-endian (8 bytes)", () => {
    expect(bytesToHex(encodeLeUint64(0n))).toBe("0000000000000000");
    expect(bytesToHex(encodeLeUint64(1n))).toBe("0100000000000000");
    expect(bytesToHex(encodeLeUint64(0x123456789abcdef0n))).toBe("f0debc9a78563412");
  });

  it("encodes varint: 1-byte for n<0xfd, 3-byte for n<0x10000, 5-byte otherwise", () => {
    expect(bytesToHex(encodeVarint(0))).toBe("00");
    expect(bytesToHex(encodeVarint(252))).toBe("fc");
    expect(bytesToHex(encodeVarint(253))).toBe("fdfd00");
    expect(bytesToHex(encodeVarint(0x1234))).toBe("fd3412");
    expect(bytesToHex(encodeVarint(0x12345678))).toBe("fe78563412");
  });
});

describe("hash256 (double SHA256)", () => {
  it("matches the SHA256d('Bitcoin') test vector", () => {
    // SHA256("Bitcoin") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    // SHA256(SHA256("Bitcoin")) = 1ab3b6827ceeea24155245b11418dd6021d6f2d4e7193172f3f8dc03c650ef6f
    // Independently verifiable; catches if either underlying sha256 round
    // is wrong or if double-hash composition is reversed.
    const out = hash256(new TextEncoder().encode("Bitcoin"));
    expect(bytesToHex(out)).toBe("1ab3b6827ceeea24155245b11418dd6021d6f2d4e7193172f3f8dc03c650ef6f");
  });
});

describe("BIP143 sighash P2WPKH", () => {
  // Canonical BIP143 example test vector. Source:
  //   https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki#native-p2wpkh
  // The vector is constructed as a 2-input, 2-output tx where input 1 is
  // P2WPKH. We verify ONLY the P2WPKH input's sighash here (input 0 is
  // legacy P2PK and follows different rules).
  //
  // Expected sighash for input 1 (the P2WPKH one):
  //   c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670
  it("computes the canonical P2WPKH sighash from the BIP143 test vector", () => {
    const tx: UnsignedSegwitTx = {
      version: 1,
      locktime: 0x11,
      inputs: [
        {
          prevTxid: "9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff",
          prevVout: 0,
          // Spent script of input 0 — not used for input 1's sighash.
          prevScriptPubkey: "2103c9f4836b9a4f77fc0d81f7bcb01b7f1b35916864b9476c241ce9fc198bd25432ac",
          prevValue: 625_000_000n,
          sequence: 0xffffffee
        },
        {
          prevTxid: "8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef",
          prevVout: 1,
          prevScriptPubkey: "00141d0f172a0ecb48aee1be1f2687d2963ae33f71a1",
          prevValue: 600_000_000n,
          sequence: 0xffffffff
        }
      ],
      outputs: [
        {
          value: 0x06_b22c20n,
          scriptPubkey:
            "76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac"
        },
        {
          value: 0x0d_519390n,
          scriptPubkey:
            "76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac"
        }
      ]
    };
    // pubkey for input 1 (compressed): 025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357
    // hash160 of that pubkey = 1d0f172a0ecb48aee1be1f2687d2963ae33f71a1 (matches scriptPubkey above)
    const pubkeyHash160 = hexToBytes("1d0f172a0ecb48aee1be1f2687d2963ae33f71a1");
    const sighash = bip143SighashP2wpkh(tx, 1, pubkeyHash160);
    expect(bytesToHex(sighash)).toBe(
      "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670"
    );
  });

  it("rejects out-of-range inputIndex", () => {
    const tx: UnsignedSegwitTx = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          prevTxid: "00".repeat(32),
          prevVout: 0,
          prevScriptPubkey: "0014" + "00".repeat(20),
          prevValue: 1000n,
          sequence: 0xffffffff
        }
      ],
      outputs: []
    };
    expect(() => bip143SighashP2wpkh(tx, 1, new Uint8Array(20))).toThrow(/out of range/);
  });

  it("rejects pubkeyHash160 of wrong length", () => {
    const tx: UnsignedSegwitTx = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          prevTxid: "00".repeat(32),
          prevVout: 0,
          prevScriptPubkey: "0014" + "00".repeat(20),
          prevValue: 1000n,
          sequence: 0xffffffff
        }
      ],
      outputs: []
    };
    expect(() => bip143SighashP2wpkh(tx, 0, new Uint8Array(19))).toThrow(/20 bytes/);
  });
});

describe("DER signature encoding", () => {
  it("encodes (r,s) into the expected DER SEQUENCE { INTEGER r, INTEGER s }", () => {
    const r = hexToBytes("11".repeat(32));
    const s = hexToBytes("22".repeat(32));
    const der = encodeDerSignature(r, s);
    // Length of each INTEGER: 0x02 + 0x20 + 32 bytes = 34 bytes
    // SEQUENCE total: 2 ints × 34 = 68 bytes; outer: 0x30 + 0x44 + body
    expect(bytesToHex(der)).toBe(
      "3044" + "0220" + "11".repeat(32) + "0220" + "22".repeat(32)
    );
  });

  it("prefixes 0x00 when the high bit of the integer is set (positive-int encoding)", () => {
    const r = hexToBytes("80" + "00".repeat(31)); // high bit set
    const s = hexToBytes("01" + "00".repeat(31));
    const der = encodeDerSignature(r, s);
    // r is now 33 bytes (0x00 + original 32) so its INTEGER is 0x02 0x21 ...
    expect(bytesToHex(der).slice(0, 8)).toBe("3045" + "0221"); // outer SEQ len = 0x45=69, r tag 0x02 len 0x21=33
  });

  it("strips leading zero bytes when present", () => {
    const r = hexToBytes("00".repeat(2) + "01" + "23".repeat(29)); // 2 leading zeros
    const s = hexToBytes("01" + "00".repeat(31));
    const der = encodeDerSignature(r, s);
    // r should be stripped to 30 bytes (32-2), so INTEGER 0x02 0x1e ...
    expect(bytesToHex(der).slice(4, 8)).toBe("021e"); // 0x1e = 30
  });
});

describe("serializeSignedTx + computeTxid", () => {
  it("rejects mismatched witness count", () => {
    const tx: SignedSegwitTx = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          prevTxid: "00".repeat(32),
          prevVout: 0,
          prevScriptPubkey: "0014" + "00".repeat(20),
          prevValue: 1000n,
          sequence: 0xffffffff
        }
      ],
      outputs: [{ value: 500n, scriptPubkey: "0014" + "11".repeat(20) }],
      witnesses: [], // 0 witnesses for 1 input — bug
    };
    expect(() => serializeSignedTx(tx)).toThrow(/witness count/);
  });

  it("produces a deterministic txid (same tx → same hash) and includes marker+flag", () => {
    const tx: SignedSegwitTx = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          prevTxid: "00".repeat(32),
          prevVout: 0,
          prevScriptPubkey: "0014" + "00".repeat(20),
          prevValue: 1000n,
          sequence: 0xffffffff
        }
      ],
      outputs: [{ value: 500n, scriptPubkey: "0014" + "11".repeat(20) }],
      witnesses: [[new Uint8Array([0x30]), new Uint8Array([0x02])]] // dummy stack
    };
    const serialized = bytesToHex(serializeSignedTx(tx));
    // Bytes 4-5 must be the segwit marker+flag (00 01) right after version.
    expect(serialized.slice(0, 8)).toBe("02000000"); // version 2 LE
    expect(serialized.slice(8, 12)).toBe("0001"); // marker + flag

    const txid1 = computeTxid(tx);
    const txid2 = computeTxid(tx);
    expect(txid1).toBe(txid2);
    expect(txid1).toMatch(/^[0-9a-f]{64}$/);
  });
});
