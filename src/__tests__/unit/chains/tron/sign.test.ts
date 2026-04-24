import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../../../adapters/chains/tron/tron-chain.adapter.js";
import type { TronRpcBackend } from "../../../../adapters/chains/tron/tron-rpc.js";

// Tron's /wallet/broadcasttransaction expects signatures laid out as
// r (32 bytes) || s (32 bytes) || v (1 byte). Noble 2.x's `format: "recovered"`
// returns them as [v, r(32), s(32)] (recovery byte FIRST), so a naive
// passthrough misaligns every field and java-tron's SignatureValidator
// rejects with errors like "Header byte out of range: 81" — not a Tron bug,
// a byte-order bug in our adapter. This test pins the layout so the fix can
// never regress: it captures the signature our adapter submits to the RPC
// backend and asserts the last byte is a valid recovery ID (0 or 1).

function fakeTronBackend(captured: { lastSignature?: string }): TronRpcBackend {
  return {
    async getNowBlock(): Promise<never> {
      throw new Error("unused");
    },
    async getAccount() {
      return { balanceSun: "1000000000" as never, trc20: {} };
    },
    async getConfirmationStatus() {
      return { blockNumber: 1, confirmations: 1, reverted: false };
    },
    async scanIncoming() {
      return [];
    },
    async createTransaction() {
      // Return a canned unsigned tx with a known 32-byte txID. The adapter
      // will sign this txID and hand us the signature via broadcastTransaction.
      return {
        txID: "a".repeat(64), // 32 bytes of 0xaa — deterministic
        raw_data: {},
        raw_data_hex: "deadbeef"
      };
    },
    async triggerConstantContract() {
      return { energy_used: 0, constant_result: [] };
    },
    async broadcastTransaction(payload: { signature: readonly string[] }) {
      captured.lastSignature = payload.signature[0] ?? "";
      return { result: true, txid: "aa".repeat(32) };
    }
  } as unknown as TronRpcBackend;
}

describe("tronChainAdapter.signAndBroadcast — signature byte layout", () => {
  it("emits r||s||v with v ∈ {0,1} (matches java-tron's SignatureValidator)", async () => {
    const captured: { lastSignature?: string } = {};
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: fakeTronBackend(captured) }
    });

    // Deterministic 32-byte private key — avoids any mnemonic/HD dependency
    // so the test pins exactly the sign-and-layout step we care about.
    const priv = "0x" + "11".repeat(32);

    const unsigned = await adapter.buildTransfer({
      chainId: TRON_MAINNET_CHAIN_ID,
      fromAddress: "TK5uF5h3S7UG5VvFPY5akChfMSUwcgsh41",
      toAddress: "TGMvWrRH4neZSmayghXBF9UZEko8BsSZLD",
      token: "TRX",
      amountRaw: "1000000"
    });
    await adapter.signAndBroadcast(unsigned, priv);

    expect(captured.lastSignature).toBeDefined();
    const sigHex = captured.lastSignature!;
    expect(sigHex.length).toBe(130); // 65 bytes × 2 hex chars

    // The recovery byte is the LAST byte (index 64 = chars 128-130).
    // java-tron accepts 0x00 or 0x01 here; anything else is a layout bug.
    const vHex = sigHex.slice(128, 130);
    expect(["00", "01"]).toContain(vHex);

    // Cross-check: the r||s portion MUST equal noble's `compact` signature
    // of the same txID — that proves we didn't mangle r or s while
    // re-ordering the recovery byte.
    const txIdBytes = new Uint8Array(32).fill(0xaa); // matches fakeTronBackend
    const privBytes = new Uint8Array(32).fill(0x11);
    const compact = secp256k1.sign(txIdBytes, privBytes, {
      format: "compact",
      prehash: false,
      lowS: true
    });
    const compactHex = Array.from(compact)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(sigHex.slice(0, 128)).toBe(compactHex);
  });
});
