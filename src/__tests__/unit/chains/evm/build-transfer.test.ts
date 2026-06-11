import { describe, expect, it } from "vitest";
import { custom } from "viem";
import { evmChainAdapter } from "../../../../adapters/chains/evm/evm-chain.adapter.js";

const noopTransport = custom({ async request() { throw new Error("no RPC in this test"); } });

function makeAdapter() {
  return evmChainAdapter({
    chainIds: [1, 999],
    transports: { 1: noopTransport, 999: noopTransport }
  });
}

describe("evmChainAdapter.buildTransfer", () => {
  it("encodes an ERC-20 transfer as transfer(address,uint256) to the token contract", async () => {
    const adapter = makeAdapter();
    const unsigned = await adapter.buildTransfer({
      chainId: 1,
      fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "USDC",
      amountRaw: "1000000"
    });

    const raw = unsigned.raw as {
      to: string;
      data: string;
      value: bigint;
      chainId: number;
      gas?: bigint;
    };
    // `to` is the USDC contract itself (not the recipient) because this is an ERC-20 call.
    expect(raw.to.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(raw.value).toBe(0n);
    expect(raw.chainId).toBe(1);
    // ERC-20 gas is pre-bound so viem skips its own eth_estimateGas call at
    // broadcast (which on BSC Alchemy simulates at an internal gas price
    // higher than our bound maxFeePerGas and rejects tight-balance txs).
    // The noop transport makes our explicit build-time estimate fail, so
    // the generous fallback constant is bound (raised from the old 65k pin
    // after Polygon's USDT0 upgrade pushed cold-recipient transfers to ~80k).
    expect(raw.gas).toBe(130_000n);

    // transfer(address,uint256) selector = keccak256("transfer(address,uint256)")[:4] = 0xa9059cbb
    expect(raw.data.slice(0, 10)).toBe("0xa9059cbb");
    // Next 32 bytes: zero-padded recipient address.
    expect(raw.data.slice(10, 10 + 64)).toBe(`${"0".repeat(24)}70997970c51812dc3a010c7d01b50e0d17dc79c8`);
    // Last 32 bytes: zero-padded amount (1_000_000 = 0xf4240).
    expect(raw.data.slice(10 + 64, 10 + 128)).toBe("00000000000000000000000000000000000000000000000000000000000f4240");
  });

  it("builds a native transfer by putting the amount in `value` and leaving data empty", async () => {
    // The dev-chain token "DEV" on chainId 999 has contractAddress=null in the registry,
    // so the adapter treats it as a native transfer path.
    const adapter = makeAdapter();
    const unsigned = await adapter.buildTransfer({
      chainId: 999,
      fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "DEV",
      amountRaw: "777"
    });

    const raw = unsigned.raw as { to: string; data: string; value: bigint; gas?: bigint };
    expect(raw.to.toLowerCase()).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(raw.data).toBe("0x");
    expect(raw.value).toBe(777n);
    // Native transfer pre-bound to the 21_000 EVM floor.
    expect(raw.gas).toBe(21_000n);
  });

  it("binds the live estimate ×1.3 when eth_estimateGas answers (USDT0 cold-recipient regression)", async () => {
    // Polygon USDT0 reported 80_204 gas for a transfer to a zero-balance
    // recipient — the old hardcoded 65k pin made exactly this tx revert
    // out-of-gas on-chain. The bound limit must track the live estimate.
    const estimatingTransport = custom({
      async request({ method }: { method: string }) {
        if (method === "eth_estimateGas") return "0x13954"; // 80_212
        throw new Error(`no ${method} in this test`);
      }
    });
    const adapter = evmChainAdapter({ chainIds: [1], transports: { 1: estimatingTransport } });
    const unsigned = await adapter.buildTransfer({
      chainId: 1,
      fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "USDC",
      amountRaw: "1000000"
    });
    const raw = unsigned.raw as { gas?: bigint };
    expect(raw.gas).toBe((80_212n * 130n) / 100n);
  });

  it("refuses to broadcast when the estimate exceeds the standard-token ceiling", async () => {
    const runawayTransport = custom({
      async request({ method }: { method: string }) {
        if (method === "eth_estimateGas") return "0x7a120"; // 500_000
        throw new Error(`no ${method} in this test`);
      }
    });
    const adapter = evmChainAdapter({ chainIds: [1], transports: { 1: runawayTransport } });
    await expect(
      adapter.buildTransfer({
        chainId: 1,
        fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        token: "USDC",
        amountRaw: "1000000"
      })
    ).rejects.toThrow(/exceeds cap/);
  });

  it("throws on an unknown token", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.buildTransfer({
        chainId: 1,
        fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        token: "FAKE",
        amountRaw: "1"
      })
    ).rejects.toThrow(/unknown token/i);
  });
});
