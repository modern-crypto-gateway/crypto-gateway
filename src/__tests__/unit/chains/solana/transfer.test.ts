import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  solanaChainAdapter,
  SOLANA_MAINNET_CHAIN_ID
} from "../../../../adapters/chains/solana/solana-chain.adapter.js";
import { encodeCompactU16, u64le } from "../../../../adapters/chains/solana/solana-message.js";
import type { SolanaRpcClient } from "../../../../adapters/chains/solana/solana-rpc-client.js";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

function fakeClient(overrides: Partial<SolanaRpcClient>): SolanaRpcClient {
  const base: SolanaRpcClient = {
    async getSlot() { throw new Error("unexpected getSlot"); },
    async getLatestBlockhash() { throw new Error("unexpected getLatestBlockhash"); },
    async getSignaturesForAddress() { throw new Error("unexpected getSignaturesForAddress"); },
    async getTransaction() { throw new Error("unexpected getTransaction"); },
    async getSignatureStatuses() { throw new Error("unexpected getSignatureStatuses"); },
    async sendTransaction() { throw new Error("unexpected sendTransaction"); }
  };
  return { ...base, ...overrides };
}

describe("solana-message compact encodings", () => {
  it("compact-u16 single-byte region (0..127)", () => {
    expect(Array.from(encodeCompactU16(0))).toEqual([0]);
    expect(Array.from(encodeCompactU16(42))).toEqual([42]);
    expect(Array.from(encodeCompactU16(127))).toEqual([127]);
  });

  it("compact-u16 two-byte region (128..16383)", () => {
    // 128 = 0b10000000  -> [0x80 | 0, 0x01] -> [0x80, 0x01]
    expect(Array.from(encodeCompactU16(128))).toEqual([0x80, 0x01]);
    // 300 = 0b100101100 -> [0x80|44, 2] = [0xac, 0x02]
    expect(Array.from(encodeCompactU16(300))).toEqual([0xac, 0x02]);
  });

  it("u64 little-endian writes the lowest byte first", () => {
    expect(Array.from(u64le(0n))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(u64le(1n))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(u64le(0xffn))).toEqual([0xff, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(u64le(0x0123456789abcdefn))).toEqual([0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01]);
  });
});

describe("solanaChainAdapter.buildTransfer (native SOL)", () => {
  it("fetches a recent blockhash, builds a signable message, and stores the message bytes in raw", async () => {
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getLatestBlockhash() {
            return { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1 };
          }
        })
      }
    });

    const { address: from } = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const { address: to } = adapter.deriveAddress(HARDHAT_MNEMONIC, 1);

    const unsigned = await adapter.buildTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: from,
      toAddress: to,
      token: "SOL",
      amountRaw: "1000000000" // 1 SOL
    });

    expect(unsigned.chainId).toBe(SOLANA_MAINNET_CHAIN_ID);
    const raw = unsigned.raw as { message: Uint8Array; fromAddress: string; recentBlockhash: string };
    expect(raw.fromAddress).toBe(from);
    expect(raw.message).toBeInstanceOf(Uint8Array);
    // Header is 3 bytes: [1 required signer, 0 readonly signed, 1 readonly unsigned].
    expect(raw.message[0]).toBe(1);
    expect(raw.message[1]).toBe(0);
    expect(raw.message[2]).toBe(1);
    // Then compact-u16 count=3 (source, dest, system program).
    expect(raw.message[3]).toBe(3);
  });

  it("rejects SPL-token buildTransfer with a clear payouts-deferred message", async () => {
    // SPL mints are now in the registry (webhook detection relies on them),
    // so buildTransfer reaches the mint-is-non-null branch and fails with the
    // deferred-payouts message — not the "unknown token" path. When SPL
    // payouts ship this test becomes the one to update.
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: fakeClient({}) }
    });
    const from = "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV";
    const to = "6UQJxnM4fZMzWWLMb72Lhzk9hWV1tJmwSZH3AGHNzR9G";
    await expect(
      adapter.buildTransfer({
        chainId: SOLANA_MAINNET_CHAIN_ID,
        fromAddress: from,
        toAddress: to,
        token: "USDC",
        amountRaw: "1"
      })
    ).rejects.toThrow(/SPL payouts.*not implemented|payouts are deferred/i);
  });
});

describe("solanaChainAdapter.signAndBroadcast", () => {
  it("signs the message with ed25519 and sends a base58 transaction; recovers the signer's pubkey", async () => {
    const recentBlockhash = base58.encode(new Uint8Array(32).fill(7));
    let sentEncoded: string | null = null;
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getLatestBlockhash() {
            return { blockhash: recentBlockhash, lastValidBlockHeight: 1 };
          },
          async sendTransaction(encoded) {
            sentEncoded = encoded;
            return "signatureReturnedByRpc";
          }
        })
      }
    });

    const { address: from, privateKey } = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const { address: to } = adapter.deriveAddress(HARDHAT_MNEMONIC, 1);

    const unsigned = await adapter.buildTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: from,
      toAddress: to,
      token: "SOL",
      amountRaw: "500"
    });

    const txHash = await adapter.signAndBroadcast(unsigned, privateKey);
    expect(txHash).toBe("signatureReturnedByRpc");
    expect(sentEncoded).not.toBeNull();

    // Decode the sent tx: 1-byte sig count (=1), 64-byte signature, then the message.
    const decoded = base58.decode(sentEncoded!);
    expect(decoded[0]).toBe(1); // compact-u16 count of signatures = 1
    const signature = decoded.slice(1, 65);
    const message = decoded.slice(65);

    // Verify ed25519 signature against the `from` public key.
    const rawUnsigned = unsigned.raw as { message: Uint8Array };
    expect(message).toEqual(rawUnsigned.message);
    // pubkey from from-address:
    const fromPubkeyBytes = base58.decode(from);
    const ok = ed25519.verify(signature, message, fromPubkeyBytes);
    expect(ok).toBe(true);
  });

  it("refuses to sign when fromAddress does not match the private key's derived pubkey", async () => {
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getLatestBlockhash() {
            return { blockhash: base58.encode(new Uint8Array(32)), lastValidBlockHeight: 1 };
          }
        })
      }
    });

    const { address: realFrom } = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const { address: to } = adapter.deriveAddress(HARDHAT_MNEMONIC, 1);
    // Build with the correct from; then try to sign with a DIFFERENT merchant's key.
    const unsigned = await adapter.buildTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: realFrom,
      toAddress: to,
      token: "SOL",
      amountRaw: "1"
    });
    const wrongKeyPair = adapter.deriveAddress(HARDHAT_MNEMONIC, 99);
    await expect(adapter.signAndBroadcast(unsigned, wrongKeyPair.privateKey)).rejects.toThrow(/does not match/i);
  });
});

describe("solanaChainAdapter.estimateGasForTransfer", () => {
  it("returns the fixed 5000-lamport per-signature fee", async () => {
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: fakeClient({}) }
    });
    const fee = await adapter.estimateGasForTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: "x",
      toAddress: "y",
      token: "SOL",
      amountRaw: "1"
    });
    expect(fee).toBe("5000");
  });
});
