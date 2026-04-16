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

    const raw = unsigned.raw as { to: string; data: string; value: bigint; chainId: number };
    // `to` is the USDC contract itself (not the recipient) because this is an ERC-20 call.
    expect(raw.to.toLowerCase()).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(raw.value).toBe(0n);
    expect(raw.chainId).toBe(1);

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

    const raw = unsigned.raw as { to: string; data: string; value: bigint };
    expect(raw.to.toLowerCase()).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(raw.data).toBe("0x");
    expect(raw.value).toBe(777n);
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
