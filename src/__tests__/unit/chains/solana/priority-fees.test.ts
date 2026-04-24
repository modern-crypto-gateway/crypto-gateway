import { describe, expect, it } from "vitest";
import {
  solanaChainAdapter,
  SOLANA_MAINNET_CHAIN_ID
} from "../../../../adapters/chains/solana/solana-chain.adapter.js";
import {
  buildNativeTransferMessage,
  encodeCompactU16,
  encodeSetComputeUnitLimit,
  encodeSetComputeUnitPrice
} from "../../../../adapters/chains/solana/solana-message.js";
import type { SolanaRpcClient } from "../../../../adapters/chains/solana/solana-rpc-client.js";

// 32 zero bytes, base58-encoded — just a placeholder recentBlockhash.
const ZERO_BLOCKHASH = "11111111111111111111111111111111";
const SOL_ADDR_A = "11111111111111111111111111111112";
const SOL_ADDR_B = "11111111111111111111111111111113";

function fakeClient(overrides: Partial<SolanaRpcClient>): SolanaRpcClient {
  const base: SolanaRpcClient = {
    async getSlot() { throw new Error("unexpected getSlot"); },
    async getLatestBlockhash() { return { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 0 }; },
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

describe("Solana priority fees — encoder primitives", () => {
  it("encodeSetComputeUnitLimit emits 5 bytes: discriminator 2 + u32 LE limit", () => {
    const out = encodeSetComputeUnitLimit(200_000);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(2);
    // 200000 little-endian = 0x030d40 → [0x40, 0x0d, 0x03, 0x00]
    expect(out[1]).toBe(0x40);
    expect(out[2]).toBe(0x0d);
    expect(out[3]).toBe(0x03);
    expect(out[4]).toBe(0x00);
  });

  it("encodeSetComputeUnitPrice emits 9 bytes: discriminator 3 + u64 LE microLamports", () => {
    const out = encodeSetComputeUnitPrice(50_000n);
    expect(out).toHaveLength(9);
    expect(out[0]).toBe(3);
    // 50_000 little-endian = 0xc350 → [0x50, 0xc3, 0, 0, 0, 0, 0, 0]
    expect(out[1]).toBe(0x50);
    expect(out[2]).toBe(0xc3);
    for (let i = 3; i < 9; i++) expect(out[i]).toBe(0);
  });
});

describe("buildNativeTransferMessage — ComputeBudget instructions", () => {
  it("without computeBudget: produces a single transfer instruction", () => {
    const msg = buildNativeTransferMessage({
      sourceAddress: SOL_ADDR_A,
      destinationAddress: SOL_ADDR_B,
      lamports: 1000n,
      recentBlockhash: ZERO_BLOCKHASH
    });
    // Header: [1, 0, 1] — 1 signer, 0 readonly-signed, 1 readonly-unsigned (System).
    expect(msg[0]).toBe(1);
    expect(msg[1]).toBe(0);
    expect(msg[2]).toBe(1);
    // accountKeys count (compact-u16): 3 (source, destination, systemProgram).
    expect(msg[3]).toBe(3);
  });

  it("with both computeBudget fields: prepends 2 CB instructions and adds CB program to accounts", () => {
    const msg = buildNativeTransferMessage({
      sourceAddress: SOL_ADDR_A,
      destinationAddress: SOL_ADDR_B,
      lamports: 1000n,
      recentBlockhash: ZERO_BLOCKHASH,
      computeBudget: {
        computeUnitLimit: 100_000,
        computeUnitPriceMicroLamports: 25_000n
      }
    });
    // Header: [1, 0, 2] — extra readonly-unsigned (ComputeBudget program).
    expect(msg[0]).toBe(1);
    expect(msg[1]).toBe(0);
    expect(msg[2]).toBe(2);
    // accountKeys count: 4 (source, destination, system, computeBudget).
    expect(msg[3]).toBe(4);

    // The tx has 3 instructions now (setLimit, setPrice, transfer). The
    // instruction-count compact-u16 lives right after the 32-byte blockhash
    // which sits right after the 4 account keys (4 * 32 = 128 bytes).
    // Offsets: header(3) + acct-count(1) + acct-keys(128) + blockhash(32) = 164
    expect(msg[164]).toBe(3);
  });
});

describe("solanaChainAdapter.quoteFeeTiers — real percentile tiers", () => {
  it("uses fallback prices when getRecentPrioritizationFees returns []", async () => {
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getRecentPrioritizationFees() {
            return [];
          }
        })
      }
    });
    const q = await adapter.quoteFeeTiers({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: SOL_ADDR_A,
      toAddress: SOL_ADDR_B,
      token: "SOL" as never,
      amountRaw: "1000" as never
    });
    expect(q.tieringSupported).toBe(true);
    // Fallbacks are low=10k medium=50k high=200k microLamports × 200k CU
    // limit / 1e6 + 5000 base = 7000, 15000, 45000 lamports.
    expect(q.low.nativeAmountRaw).toBe("7000");
    expect(q.medium.nativeAmountRaw).toBe("15000");
    expect(q.high.nativeAmountRaw).toBe("45000");
  });

  it("buckets real samples to 25th/50th/75th percentiles", async () => {
    // Known 8-sample input sorted ascending: [1000, 2000, 3000, 5000, 8000, 13000, 21000, 34000].
    // Percentile formula used: idx = floor(p * N). For N=8:
    //   25th: idx = floor(0.25*8) = 2 → 3000
    //   50th: idx = floor(0.50*8) = 4 → 8000
    //   75th: idx = floor(0.75*8) = 6 → 21000
    const samples = [1000, 2000, 3000, 5000, 8000, 13000, 21000, 34000].map(
      (n, i) => ({ slot: 1_000_000 + i, prioritizationFee: n })
    );
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getRecentPrioritizationFees() {
            return samples;
          }
        })
      }
    });
    const q = await adapter.quoteFeeTiers({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: SOL_ADDR_A,
      toAddress: SOL_ADDR_B,
      token: "SOL" as never,
      amountRaw: "1" as never
    });
    // (200000 CU × microLamports / 1e6) + 5000 base.
    //   low:    3000 × 200000 / 1e6 + 5000 = 600 + 5000 = 5600
    //   medium: 8000 × 200000 / 1e6 + 5000 = 1600 + 5000 = 6600
    //   high:   21000 × 200000 / 1e6 + 5000 = 4200 + 5000 = 9200
    expect(q.low.nativeAmountRaw).toBe("5600");
    expect(q.medium.nativeAmountRaw).toBe("6600");
    expect(q.high.nativeAmountRaw).toBe("9200");
    expect(q.tieringSupported).toBe(true);
  });

  it("feeTier is threaded into buildTransfer — resulting msg has ComputeBudget bound", async () => {
    let priorityCalls = 0;
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getRecentPrioritizationFees() {
            priorityCalls += 1;
            return [{ slot: 1, prioritizationFee: 12345 }];
          }
        })
      }
    });
    const unsigned = await adapter.buildTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: SOL_ADDR_A,
      toAddress: SOL_ADDR_B,
      token: "SOL" as never,
      amountRaw: "1000" as never,
      feeTier: "high"
    });
    expect(priorityCalls).toBe(1);
    const msg = (unsigned.raw as { message: Uint8Array }).message;
    // Header readonly-unsigned count = 2 (systemProgram + computeBudget).
    expect(msg[2]).toBe(2);
  });

  it("no feeTier: buildTransfer skips the priority-fee RPC entirely (no cost on quiet path)", async () => {
    let priorityCalls = 0;
    const adapter = solanaChainAdapter({
      chainIds: [SOLANA_MAINNET_CHAIN_ID],
      clients: {
        [SOLANA_MAINNET_CHAIN_ID]: fakeClient({
          async getRecentPrioritizationFees() {
            priorityCalls += 1;
            return [];
          }
        })
      }
    });
    const unsigned = await adapter.buildTransfer({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      fromAddress: SOL_ADDR_A,
      toAddress: SOL_ADDR_B,
      token: "SOL" as never,
      amountRaw: "1000" as never
      // feeTier omitted
    });
    expect(priorityCalls).toBe(0);
    const msg = (unsigned.raw as { message: Uint8Array }).message;
    // Header readonly-unsigned count = 1 (system program only; no ComputeBudget).
    expect(msg[2]).toBe(1);
  });
});

// Silence the unused-import warning for HARDHAT_MNEMONIC — imported for
// parity with the adjacent transfer.test.ts helper but not needed here.
void encodeCompactU16;
