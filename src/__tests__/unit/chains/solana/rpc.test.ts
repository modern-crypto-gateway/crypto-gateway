import { describe, expect, it } from "vitest";
import {
  solanaChainAdapter,
  SOLANA_MAINNET_CHAIN_ID
} from "../../../../adapters/chains/solana/solana-chain.adapter.js";
import type { SolanaRpcClient } from "../../../../adapters/chains/solana/solana-rpc-client.js";

function fakeClient(overrides: Partial<SolanaRpcClient>): SolanaRpcClient {
  const base: SolanaRpcClient = {
    async getSlot() {
      throw new Error("unexpected getSlot");
    },
    async getLatestBlockhash() {
      throw new Error("unexpected getLatestBlockhash");
    },
    async getSignaturesForAddress() {
      throw new Error("unexpected getSignaturesForAddress");
    },
    async getTransaction() {
      throw new Error("unexpected getTransaction");
    },
    async getSignatureStatuses() {
      throw new Error("unexpected getSignatureStatuses");
    },
    async sendTransaction() {
      throw new Error("unexpected sendTransaction");
    }
  };
  return { ...base, ...overrides };
}

describe("solanaChainAdapter.scanIncoming", () => {
  it("returns empty when no addresses are supplied (no RPC calls)", async () => {
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getSignaturesForAddress() {
            throw new Error("must not be called");
          }
        })
      }
    });
    const result = await adapter.scanIncoming({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      addresses: [],
      tokens: ["SOL"],
      sinceMs: Date.now() - 60_000
    });
    expect(result).toEqual([]);
  });

  it("skips when the caller didn't ask for SOL (SPL detection is Phase 7.5)", async () => {
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getSignaturesForAddress() {
            throw new Error("must not be called when only SPL tokens requested");
          }
        })
      }
    });
    const result = await adapter.scanIncoming({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      addresses: ["A".repeat(43)],
      tokens: ["USDC"],
      sinceMs: Date.now() - 60_000
    });
    expect(result).toEqual([]);
  });

  it("reads native SOL transfers from signature+transaction responses, using balance deltas", async () => {
    const recipient = "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV"; // arbitrary 32-byte base58
    const sender = "6UQJxnM4fZMzWWLMb72Lhzk9hWV1tJmwSZH3AGHNzR9G";

    const client = fakeClient({
      async getSignaturesForAddress(address, _opts) {
        expect(address).toBe(recipient);
        return [
          {
            signature: "sig1".repeat(16), // any non-empty base58-ish string
            slot: 2_000_000,
            blockTime: Math.floor(Date.now() / 1000),
            err: null,
            confirmationStatus: "finalized"
          }
        ];
      },
      async getTransaction(signature) {
        expect(signature).toMatch(/^sig1/);
        return {
          slot: 2_000_000,
          blockTime: Math.floor(Date.now() / 1000),
          meta: {
            err: null,
            fee: 5000,
            // accountKeys ordering [sender, recipient, systemProgram]
            preBalances: [1_000_000_000, 0, 1],
            postBalances: [1_000_000_000 - 5000 - 123_456, 123_456, 1]
          },
          transaction: {
            message: {
              accountKeys: [sender, recipient, "11111111111111111111111111111111"],
              instructions: []
            },
            signatures: ["sig1".repeat(16)]
          }
        };
      }
    });

    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
    });

    const transfers = await adapter.scanIncoming({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      addresses: [recipient],
      tokens: ["SOL"],
      sinceMs: Date.now() - 60_000
    });

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      txHash: "sig1".repeat(16),
      logIndex: null,
      fromAddress: sender,
      toAddress: recipient,
      token: "SOL",
      amountRaw: "123456",
      blockNumber: 2_000_000,
      confirmations: 32 // "finalized" maps to at-least 32 confirmations
    });
  });

  it("ignores failed transactions (err !== null)", async () => {
    const recipient = "4LLm2rsDjYxSp3N5yXYBY4xA3mo7JLEhRaVA3yZJvZfV";
    const client = fakeClient({
      async getSignaturesForAddress() {
        return [
          {
            signature: "sigFail".padEnd(64, "x"),
            slot: 1,
            blockTime: Math.floor(Date.now() / 1000),
            err: { InstructionError: [0, "Custom"] },
            confirmationStatus: "confirmed"
          }
        ];
      }
    });
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
    });
    const transfers = await adapter.scanIncoming({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      addresses: [recipient],
      tokens: ["SOL"],
      sinceMs: Date.now() - 60_000
    });
    expect(transfers).toEqual([]);
  });
});

describe("solanaChainAdapter.getConfirmationStatus", () => {
  it("reports finalized as at-least 32 confirmations, not reverted", async () => {
    const client = fakeClient({
      async getSignatureStatuses() {
        return [{ slot: 2_000_000, confirmations: null, err: null, confirmationStatus: "finalized" }];
      },
      async getSlot() {
        return 2_000_050;
      }
    });
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
    });
    const status = await adapter.getConfirmationStatus(SOLANA_MAINNET_CHAIN_ID, "sig");
    expect(status).toEqual({ blockNumber: 2_000_000, confirmations: 50, reverted: false });
  });

  it("reports confirmed with the numeric confirmations count from the RPC", async () => {
    const client = fakeClient({
      async getSignatureStatuses() {
        return [{ slot: 2_000_000, confirmations: 5, err: null, confirmationStatus: "confirmed" }];
      },
      async getSlot() {
        return 2_000_005;
      }
    });
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
    });
    const status = await adapter.getConfirmationStatus(SOLANA_MAINNET_CHAIN_ID, "sig");
    expect(status).toEqual({ blockNumber: 2_000_000, confirmations: 5, reverted: false });
  });

  it("flags reverted=true when err is non-null on the signature status", async () => {
    const client = fakeClient({
      async getSignatureStatuses() {
        return [
          { slot: 1, confirmations: 5, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }
        ];
      },
      async getSlot() {
        return 10;
      }
    });
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
    });
    const status = await adapter.getConfirmationStatus(SOLANA_MAINNET_CHAIN_ID, "sig");
    expect(status.reverted).toBe(true);
  });

  it("returns zero confirmations when the RPC reports null for this signature", async () => {
    const client = fakeClient({
      async getSignatureStatuses() {
        return [null];
      },
      async getSlot() {
        return 10;
      }
    });
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: { [SOLANA_MAINNET_CHAIN_ID]: client }
    });
    const status = await adapter.getConfirmationStatus(SOLANA_MAINNET_CHAIN_ID, "sig");
    expect(status).toEqual({ blockNumber: null, confirmations: 0, reverted: false });
  });
});
