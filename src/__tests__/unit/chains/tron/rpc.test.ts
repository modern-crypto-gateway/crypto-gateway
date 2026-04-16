import { describe, expect, it } from "vitest";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../../../adapters/chains/tron/tron-chain.adapter.js";
import type { TronRpcBackend } from "../../../../adapters/chains/tron/tron-rpc.js";

// USDT TRC-20 contract on Tron mainnet, matching the token registry entry.
const USDT_TRON_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// Build a fake Tron RPC backend that only implements the methods the test
// exercises. Any method we didn't stub throws loudly, so we notice accidental
// extra calls.
function fakeClient(overrides: Partial<TronRpcBackend>): TronRpcBackend {
  const stub: TronRpcBackend = {
    name: "fake",
    supportsDetection: true,
    async listTrc20Transfers() {
      throw new Error("unexpected listTrc20Transfers call");
    },
    async getTransactionInfo() {
      throw new Error("unexpected getTransactionInfo call");
    },
    async getNowBlock() {
      throw new Error("unexpected getNowBlock call");
    },
    async triggerSmartContract() {
      throw new Error("unexpected triggerSmartContract call");
    },
    async broadcastTransaction() {
      throw new Error("unexpected broadcastTransaction call");
    }
  };
  return { ...stub, ...overrides };
}

describe("tronChainAdapter.scanIncoming", () => {
  it("returns an empty list when no addresses are supplied", async () => {
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: {
        [TRON_MAINNET_CHAIN_ID]: fakeClient({
          async listTrc20Transfers() {
            throw new Error("scanIncoming must not hit TronGrid when addresses=[]");
          }
        })
      }
    });
    const result = await adapter.scanIncoming({
      chainId: TRON_MAINNET_CHAIN_ID,
      addresses: [],
      tokens: ["USDT"],
      sinceMs: Date.now() - 60_000
    });
    expect(result).toEqual([]);
  });

  it("maps a TronGrid TRC-20 transfer to a DetectedTransfer with the right shape", async () => {
    const toAddr = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const fromAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

    const client = fakeClient({
      async listTrc20Transfers(address, opts) {
        expect(address).toBe(toAddr);
        expect(opts?.contractAddress).toBe(USDT_TRON_CONTRACT);
        return [
          {
            transaction_id: "ab".repeat(32),
            block_timestamp: 1_700_000_000_000,
            block: 55_000_000,
            from: fromAddr,
            to: toAddr,
            value: "1000000", // 1 USDT (6 decimals)
            token_info: {
              address: USDT_TRON_CONTRACT,
              decimals: 6,
              name: "Tether USD",
              symbol: "USDT"
            },
            type: "Transfer"
          }
        ];
      }
    });

    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });

    const transfers = await adapter.scanIncoming({
      chainId: TRON_MAINNET_CHAIN_ID,
      addresses: [toAddr],
      tokens: ["USDT"],
      sinceMs: Date.now() - 60_000
    });

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      chainId: TRON_MAINNET_CHAIN_ID,
      txHash: "ab".repeat(32),
      logIndex: null,
      fromAddress: fromAddr,
      toAddress: toAddr,
      token: "USDT",
      amountRaw: "1000000",
      blockNumber: 55_000_000,
      confirmations: 0
    });
  });

  it("filters out transfers whose `to` is not one of our watched addresses", async () => {
    const ourAddr = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const strangerAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

    const client = fakeClient({
      async listTrc20Transfers() {
        return [
          {
            transaction_id: "ab".repeat(32),
            block_timestamp: 1_700_000_000_000,
            block: 55_000_000,
            from: strangerAddr,
            to: strangerAddr, // NOT our address
            value: "1000000",
            token_info: { address: USDT_TRON_CONTRACT, decimals: 6, name: "", symbol: "USDT" },
            type: "Transfer"
          }
        ];
      }
    });

    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const transfers = await adapter.scanIncoming({
      chainId: TRON_MAINNET_CHAIN_ID,
      addresses: [ourAddr],
      tokens: ["USDT"],
      sinceMs: Date.now() - 60_000
    });
    expect(transfers).toEqual([]);
  });
});

describe("tronChainAdapter.getConfirmationStatus", () => {
  it("computes confirmations from the receipt block and the current tip", async () => {
    const client = fakeClient({
      async getTransactionInfo() {
        return { blockNumber: 55_000_000, receipt: { result: "SUCCESS" } };
      },
      async getNowBlock() {
        return { block_header: { raw_data: { number: 55_000_020 } } };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const status = await adapter.getConfirmationStatus(TRON_MAINNET_CHAIN_ID, "ab".repeat(32));
    expect(status).toEqual({ blockNumber: 55_000_000, confirmations: 21, reverted: false });
  });

  it("treats receipt.result other than SUCCESS as reverted", async () => {
    const client = fakeClient({
      async getTransactionInfo() {
        return { blockNumber: 55_000_000, receipt: { result: "REVERT" } };
      },
      async getNowBlock() {
        return { block_header: { raw_data: { number: 55_000_001 } } };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const status = await adapter.getConfirmationStatus(TRON_MAINNET_CHAIN_ID, "ab".repeat(32));
    expect(status.reverted).toBe(true);
  });

  it("returns zero confirmations (not reverted) for a not-yet-known tx", async () => {
    const client = fakeClient({
      async getTransactionInfo() {
        return null;
      },
      async getNowBlock() {
        return { block_header: { raw_data: { number: 55_000_000 } } };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const status = await adapter.getConfirmationStatus(TRON_MAINNET_CHAIN_ID, "ab".repeat(32));
    expect(status).toEqual({ blockNumber: null, confirmations: 0, reverted: false });
  });
});

describe("tronChainAdapter.buildTransfer (TRC-20)", () => {
  it("invokes triggersmartcontract with transfer(address,uint256) and ABI-encoded params", async () => {
    const ownerBase58 = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    const toBase58 = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";

    let captured: { owner: string; contract: string; selector: string; parameter: string } | null = null;

    const client = fakeClient({
      async triggerSmartContract(params) {
        captured = {
          owner: params.owner_address,
          contract: params.contract_address,
          selector: params.function_selector,
          parameter: params.parameter
        };
        return {
          transaction: {
            raw_data: { dummy: true },
            raw_data_hex: "deadbeef",
            txID: "ab".repeat(32)
          },
          energy_used: 30_000,
          result: { result: true }
        };
      }
    });

    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });

    const unsigned = await adapter.buildTransfer({
      chainId: TRON_MAINNET_CHAIN_ID,
      fromAddress: ownerBase58,
      toAddress: toBase58,
      token: "USDT",
      amountRaw: "1000000"
    });

    expect(captured).not.toBeNull();
    expect(captured!.selector).toBe("transfer(address,uint256)");

    // Parameter: 32-byte padded recipient core (hex of base58 minus 0x41 prefix)
    // followed by 32-byte padded amount (1_000_000 = 0xf4240).
    expect(captured!.parameter.slice(-64)).toBe("00000000000000000000000000000000000000000000000000000000000f4240");
    // First 24 hex chars of the first param must be zeros (address padding).
    expect(captured!.parameter.slice(0, 24)).toBe("000000000000000000000000");

    expect((unsigned.raw as { txID: string }).txID).toBe("ab".repeat(32));
  });
});
