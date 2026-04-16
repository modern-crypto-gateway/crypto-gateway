import { describe, expect, it } from "vitest";
import { custom } from "viem";
import { evmChainAdapter } from "../../../../adapters/chains/evm/evm-chain.adapter.js";
import { ERC20_TRANSFER_EVENT_TOPIC0 } from "../../../../adapters/chains/evm/erc20.js";

// USDC contract address on Ethereum mainnet — matches the token-registry entry.
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Helpers for building synthetic eth_getLogs responses.
function padAddress(addr: string): string {
  return `0x${"0".repeat(24)}${addr.replace(/^0x/, "").toLowerCase()}`;
}
function padUint256(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

// Build a mock transport that dispatches on JSON-RPC `method` to a fixed set
// of handlers. Any method the test didn't explicitly cover throws loudly so
// we notice accidental unintended RPC dependencies.
function mockTransport(handlers: Record<string, (params: unknown[]) => unknown>) {
  return custom({
    async request({ method, params }) {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected JSON-RPC call: ${method}`);
      return handler((params ?? []) as unknown[]);
    }
  });
}

describe("evmChainAdapter.scanIncoming", () => {
  it("decodes ERC-20 Transfer logs returned by eth_getLogs into DetectedTransfers", async () => {
    const fromAddr = "0x1111111111111111111111111111111111111111";
    const toAddr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const latestBlock = 1_000;
    const eventBlock = 995;

    const transport = mockTransport({
      eth_blockNumber: () => hex(latestBlock),
      eth_getLogs: (params) => {
        const [filter] = params as [{ address: string; topics: readonly string[]; fromBlock: string; toBlock: string }];
        // Sanity: only the USDC contract is scanned since that's the only token requested.
        expect(filter.address.toLowerCase()).toBe(USDC_MAINNET.toLowerCase());
        // Sanity: topic0 is the Transfer signature; topic2 filters on our recipient.
        expect(filter.topics[0]).toBe(ERC20_TRANSFER_EVENT_TOPIC0);
        return [
          {
            address: USDC_MAINNET.toLowerCase(),
            topics: [ERC20_TRANSFER_EVENT_TOPIC0, padAddress(fromAddr), padAddress(toAddr)],
            data: padUint256(1_500_000n), // 1.5 USDC (6 decimals)
            blockNumber: hex(eventBlock),
            blockHash: `0x${"b".repeat(64)}`,
            transactionHash: `0x${"a".repeat(64)}`,
            transactionIndex: "0x0",
            logIndex: "0x3",
            removed: false
          }
        ];
      }
    });

    const adapter = evmChainAdapter({
      chainIds: [1],
      transports: { 1: transport }
    });

    const transfers = await adapter.scanIncoming({
      chainId: 1,
      addresses: [toAddr],
      tokens: ["USDC"],
      sinceMs: Date.now() - 60_000
    });

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      chainId: 1,
      txHash: `0x${"a".repeat(64)}`,
      logIndex: 3,
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: toAddr, // checksummed
      token: "USDC",
      amountRaw: "1500000",
      blockNumber: eventBlock,
      confirmations: latestBlock - eventBlock + 1
    });
  });

  it("returns an empty list when no addresses are supplied", async () => {
    // No RPC should be hit at all.
    const transport = mockTransport({
      eth_blockNumber: () => {
        throw new Error("scanIncoming must not call eth_blockNumber when addresses=[]");
      }
    });
    const adapter = evmChainAdapter({ chainIds: [1], transports: { 1: transport } });
    const result = await adapter.scanIncoming({
      chainId: 1,
      addresses: [],
      tokens: ["USDC"],
      sinceMs: Date.now() - 1_000
    });
    expect(result).toEqual([]);
  });

  it("skips tokens that are not in the registry for this chain", async () => {
    let getLogsCalls = 0;
    const transport = mockTransport({
      eth_blockNumber: () => hex(1000),
      eth_getLogs: () => {
        getLogsCalls += 1;
        return [];
      }
    });
    const adapter = evmChainAdapter({ chainIds: [1], transports: { 1: transport } });

    await adapter.scanIncoming({
      chainId: 1,
      addresses: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
      tokens: ["USDC", "UNKNOWN_TOKEN", "DEV"], // only USDC is registered on chain 1
      sinceMs: Date.now() - 60_000
    });

    expect(getLogsCalls).toBe(1);
  });
});

describe("evmChainAdapter.getConfirmationStatus", () => {
  it("reports confirmations from the receipt block number and current tip", async () => {
    const transport = mockTransport({
      eth_getTransactionReceipt: () => ({
        status: "0x1",
        blockNumber: hex(100),
        blockHash: `0x${"b".repeat(64)}`,
        transactionHash: `0x${"a".repeat(64)}`,
        transactionIndex: "0x0",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        type: "0x2",
        effectiveGasPrice: "0x1"
      }),
      eth_blockNumber: () => hex(112)
    });

    const adapter = evmChainAdapter({ chainIds: [1], transports: { 1: transport } });
    const status = await adapter.getConfirmationStatus(1, `0x${"a".repeat(64)}`);
    expect(status).toEqual({ blockNumber: 100, confirmations: 13, reverted: false });
  });

  it("reports reverted=true for a receipt with status=0x0", async () => {
    const transport = mockTransport({
      eth_getTransactionReceipt: () => ({
        status: "0x0",
        blockNumber: hex(50),
        blockHash: `0x${"b".repeat(64)}`,
        transactionHash: `0x${"a".repeat(64)}`,
        transactionIndex: "0x0",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        type: "0x2",
        effectiveGasPrice: "0x1"
      }),
      eth_blockNumber: () => hex(60)
    });
    const adapter = evmChainAdapter({ chainIds: [1], transports: { 1: transport } });
    const status = await adapter.getConfirmationStatus(1, `0x${"a".repeat(64)}`);
    expect(status).toEqual({ blockNumber: 50, confirmations: 11, reverted: true });
  });

  it("returns zero confirmations (not reverted) when the receipt is unknown", async () => {
    const transport = mockTransport({
      eth_getTransactionReceipt: () => null,
      eth_blockNumber: () => hex(100)
    });
    const adapter = evmChainAdapter({ chainIds: [1], transports: { 1: transport } });
    const status = await adapter.getConfirmationStatus(1, `0x${"a".repeat(64)}`);
    expect(status).toEqual({ blockNumber: null, confirmations: 0, reverted: false });
  });
});
