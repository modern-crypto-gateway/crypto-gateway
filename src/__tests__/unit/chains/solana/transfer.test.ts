import { describe, expect, it, vi } from "vitest";
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
    async getBlockHeight() { throw new Error("unexpected getBlockHeight"); },
    async getLatestBlockhash() { throw new Error("unexpected getLatestBlockhash"); },
    async getSignaturesForAddress() { throw new Error("unexpected getSignaturesForAddress"); },
    async getTransaction() { throw new Error("unexpected getTransaction"); },
    async getSignatureStatuses() { throw new Error("unexpected getSignatureStatuses"); },
    async sendTransaction() { throw new Error("unexpected sendTransaction"); },
    async getBalance() { throw new Error("unexpected getBalance"); },
    async getTokenAccountsByOwner() { throw new Error("unexpected getTokenAccountsByOwner"); },
    async accountExists() { return true; },
    async getRecentPrioritizationFees() { return []; }
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
            return { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 350_000_123 };
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
    // Tx-expiry watermark rides the UnsignedTx so the executor can persist
    // it — the confirm sweep's proof that an absent tx is dead, not slow.
    expect(unsigned.lastValidBlockHeight).toBe(350_000_123);
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

  it("builds an SPL TransferChecked + idempotent ATA-create for a USDC payout", async () => {
    // SPL path: the registry exposes USDC/USDT mints on chainId 900, so this
    // flows through the contractAddress != null branch into the SPL builder.
    // The resulting message must carry 8 accountKeys and two instructions
    // (CreateIdempotent ATA + TransferChecked) in that order.
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getLatestBlockhash() {
            return { blockhash: base58.encode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 350_000_456 };
          }
        })
      }
    });
    const from = "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV";
    const to = "6UQJxnM4fZMzWWLMb72Lhzk9hWV1tJmwSZH3AGHNzR9G";
    const unsigned = await adapter.buildTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: from,
      toAddress: to,
      token: "USDC",
      amountRaw: "1000000"
    });
    expect(unsigned.lastValidBlockHeight).toBe(350_000_456);
    const raw = unsigned.raw as { message: Uint8Array; fromAddress: string };
    expect(raw.fromAddress).toBe(from);
    // Header: 1 required signer, 0 readonly signed, 5 readonly unsigned.
    expect(raw.message[0]).toBe(1);
    expect(raw.message[1]).toBe(0);
    expect(raw.message[2]).toBe(5);
    // Then compact-u16 count=8 (sender owner, sender ATA, recipient ATA,
    // mint, recipient owner, system, token, associated-token).
    expect(raw.message[3]).toBe(8);
    expect(unsigned.summary).toMatch(/SPL USDC transfer 1000000/);
  });
});

describe("solanaChainAdapter.signAndBroadcast", () => {
  it("signs the message with ed25519 and sends a base58 transaction; recovers the signer's pubkey", async () => {
    const recentBlockhash = base58.encode(new Uint8Array(32).fill(7));
    let sentEncoded: string | null = null;
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      // This test is about signing/encoding — disable the confirm-or-resend
      // window so signAndBroadcast returns after the first send.
      broadcastResend: { maxResends: 0 },
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
    expect(sentEncoded).not.toBeNull();

    // Decode the sent tx: 1-byte sig count (=1), 64-byte signature, then the message.
    const decoded = base58.decode(sentEncoded!);
    expect(decoded[0]).toBe(1); // compact-u16 count of signatures = 1
    const signature = decoded.slice(1, 65);
    const message = decoded.slice(65);

    // The returned txHash is the LOCALLY-derived first signature — the RPC's
    // echoed string ("signatureReturnedByRpc" above) is untrusted and ignored.
    expect(txHash).toBe(base58.encode(signature));

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

describe("solanaChainAdapter.signAndBroadcast confirm-or-resend window", () => {
  const recentBlockhash = base58.encode(new Uint8Array(32).fill(7));

  // Builds an adapter whose sendTransaction records every submission and
  // whose getSignatureStatuses is scripted per poll. intervalMs=1 so the
  // (detached, fire-and-forget) window elapses almost instantly; tests
  // vi.waitFor the background loop's terminal effects. Omitting maxResends
  // exercises the adapter's production default (BROADCAST_MAX_RESENDS).
  function resendHarness(args: {
    statusPerPoll: ReadonlyArray<{ seen: boolean } | "throw">;
    resendError?: Error;
    maxResends?: number;
  }) {
    const sends: string[] = [];
    const polled: string[] = [];
    let polls = 0;
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      broadcastResend:
        args.maxResends === undefined
          ? { intervalMs: 1 }
          : { intervalMs: 1, maxResends: args.maxResends },
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getLatestBlockhash() {
            return { blockhash: recentBlockhash, lastValidBlockHeight: 1 };
          },
          async sendTransaction(encoded) {
            if (sends.length > 0 && args.resendError) throw args.resendError;
            sends.push(encoded);
            return "rpcEchoDeliberatelyWrong"; // ignored — txHash is derived locally
          },
          async getSignatureStatuses(signatures) {
            polled.push(signatures[0]!);
            const script = args.statusPerPoll[polls] ?? { seen: false };
            polls += 1;
            if (script === "throw") throw new Error("rpc flap");
            return script.seen
              ? [{ slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" }]
              : [null];
          }
        })
      }
    });
    return { adapter, sends, polled, pollCount: () => polls };
  }

  async function broadcastOnce(adapter: ReturnType<typeof solanaChainAdapter>) {
    const { address: from, privateKey } = adapter.deriveAddress(HARDHAT_MNEMONIC, 0);
    const { address: to } = adapter.deriveAddress(HARDHAT_MNEMONIC, 1);
    const unsigned = await adapter.buildTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: from,
      toAddress: to,
      token: "SOL",
      amountRaw: "500"
    });
    return adapter.signAndBroadcast(unsigned, privateKey);
  }

  // The locally-derived txid: first signature of the encoded wire tx.
  function signatureOf(encodedTx: string): string {
    return base58.encode(base58.decode(encodedTx).slice(1, 65));
  }

  it("returns the local txHash immediately, then re-sends identical bytes until the RPC sees the signature", async () => {
    // Poll 1: unseen → resend. Poll 2: seen → stop with a resend budget left.
    const h = resendHarness({ statusPerPoll: [{ seen: false }, { seen: true }] });
    const txHash = await broadcastOnce(h.adapter);
    // Returned before the window ran to completion (fire-and-forget) with
    // the locally-derived signature, not the RPC's (wrong) echo.
    expect(h.sends).toHaveLength(1);
    expect(txHash).toBe(signatureOf(h.sends[0]!));
    await vi.waitFor(() => expect(h.pollCount()).toBe(2));
    expect(h.sends).toHaveLength(2);
    // Idempotency contract: every resend is byte-for-byte the first send,
    // and every poll queries the locally-derived signature.
    expect(h.sends[1]).toBe(h.sends[0]);
    expect(h.polled).toEqual([txHash, txHash]);
  });

  it("gives up after maxResends and leaves the original txHash standing", async () => {
    const h = resendHarness({
      statusPerPoll: [{ seen: false }, { seen: false }, { seen: false }],
      maxResends: 2
    });
    const txHash = await broadcastOnce(h.adapter);
    expect(txHash).toBe(signatureOf(h.sends[0]!));
    await vi.waitFor(() => expect(h.sends).toHaveLength(3)); // initial + 2 resends
    expect(h.pollCount()).toBe(2);
  });

  it("runs the production default of 3 resends when broadcastResend.maxResends is not configured", async () => {
    // Pins the `?? BROADCAST_MAX_RESENDS` fallback — every other test passes
    // an explicit maxResends, so a regression of the default (e.g. to 0)
    // would otherwise go unnoticed while silently disabling the window.
    const h = resendHarness({ statusPerPoll: [] }); // every poll: unseen
    await broadcastOnce(h.adapter);
    await vi.waitFor(() => expect(h.sends).toHaveLength(4)); // initial + 3 resends
    expect(h.pollCount()).toBe(3);
  });

  it("swallows poll and resend errors — the first successful send owns the txHash", async () => {
    const h = resendHarness({
      statusPerPoll: ["throw", { seen: false }, { seen: false }],
      resendError: new Error("Transaction simulation failed: This transaction has already been processed")
    });
    const txHash = await broadcastOnce(h.adapter);
    expect(txHash).toBe(signatureOf(h.sends[0]!));
    // Loop runs its full default budget: poll 1 throws (no resend), polls
    // 2-3 unseen with resends throwing — all swallowed, nothing recorded.
    await vi.waitFor(() => expect(h.pollCount()).toBe(3));
    expect(h.sends).toHaveLength(1);
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
