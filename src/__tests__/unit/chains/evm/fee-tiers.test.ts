import { describe, expect, it } from "vitest";
import { custom } from "viem";
import { evmChainAdapter } from "../../../../adapters/chains/evm/evm-chain.adapter.js";

// These tests exercise the EVM adapter's fee-quoting path end-to-end via a
// mock JSON-RPC transport. We feed synthetic `eth_feeHistory` /
// `eth_maxPriorityFeePerGas` / `eth_gasPrice` responses to assert that
// per-chain floors kick in when the RPC reports values below them, and that
// `getFeeHistory` medians are used on the happy path.
//
// The key regression this guards against: the BSC native-payout failure that
// motivated this module — quote returned 0.05 gwei × 21000 = 1.05e12 wei of
// fee, reservation was 1.5× that, broadcast failed at the chain with
// "insufficient funds for gas * price + value" because actual inclusion cost
// was several-fold higher. With the floor (1 gwei min priority, 3 gwei min
// maxFeePerGas on BSC) the quote now lands at 3e9 × 21000 = 6.3e13 wei — 60×
// the old quote, still well under a cent, and the picker reserves enough.

// Convert a gwei number literal to wei as bigint without any floating-point
// wobble.
function gwei(n: number): bigint {
  // Everything we quote is a whole-gwei or clean fraction — scale by 1e9
  // integer-style to stay exact.
  return BigInt(n * 1_000_000_000);
}
function hex(n: bigint | number): string {
  const v = typeof n === "bigint" ? n : BigInt(n);
  return `0x${v.toString(16)}`;
}

// Build a transport that answers the JSON-RPC methods our fee path uses.
// Any unexpected method throws loudly so tests notice unintended calls.
interface MockResponses {
  feeHistory?: {
    baseFeePerGas: readonly bigint[];
    reward: readonly (readonly bigint[])[];
  } | "throw";
  maxPriority?: bigint | "throw";
  gasPrice?: bigint | "throw";
  estimateGas?: bigint | "throw";
}
function feeTransport(responses: MockResponses) {
  return custom({
    async request({ method }) {
      switch (method) {
        case "eth_feeHistory": {
          if (responses.feeHistory === "throw") throw new Error("feeHistory not supported");
          if (responses.feeHistory === undefined) throw new Error("feeHistory not mocked");
          return {
            oldestBlock: "0x0",
            baseFeePerGas: responses.feeHistory.baseFeePerGas.map(hex),
            gasUsedRatio: responses.feeHistory.reward.map(() => 0.5),
            reward: responses.feeHistory.reward.map((row) => row.map(hex))
          };
        }
        case "eth_maxPriorityFeePerGas": {
          if (responses.maxPriority === "throw") throw new Error("maxPriorityFeePerGas not supported");
          if (responses.maxPriority === undefined) throw new Error("maxPriority not mocked");
          return hex(responses.maxPriority);
        }
        case "eth_gasPrice": {
          if (responses.gasPrice === "throw") throw new Error("gasPrice not supported");
          if (responses.gasPrice === undefined) throw new Error("gasPrice not mocked");
          return hex(responses.gasPrice);
        }
        case "eth_getBlockByNumber": {
          // viem reads baseFeePerGas from the latest block for estimateFeesPerGas.
          // Return zeros — our tests that care about baseFee use feeHistory.
          return { number: "0x1", baseFeePerGas: "0x0" };
        }
        case "eth_chainId": {
          return "0x38"; // BSC, overridden by the adapter-level chainId arg anyway
        }
        case "eth_estimateGas": {
          if (responses.estimateGas === "throw") throw new Error("estimateGas failed");
          if (responses.estimateGas === undefined) return hex(21_000n);
          return hex(responses.estimateGas);
        }
        default:
          throw new Error(`unexpected JSON-RPC call in fee-tiers test: ${method}`);
      }
    }
  });
}

describe("evmChainAdapter fee quoting — per-chain floors", () => {
  it("floors BSC native-transfer quote at 3 gwei maxFeePerGas when feeHistory returns ~0.05 gwei", async () => {
    // The exact failure scenario: every block in the window returned 0.05 gwei
    // priority, baseFee 0 (BSC BEP-226 always-zero baseFee). Pre-floor the
    // quote would be 21000 × 0.05 gwei = 1.05e12 wei. With the 3 gwei floor
    // (matches Alchemy BSC's internal `eth_gasPrice`-based submission check),
    // the quote is 21000 × 3 gwei = 6.3e13 wei.
    const adapter = evmChainAdapter({
      chainIds: [56],
      transports: {
        56: feeTransport({
          feeHistory: {
            baseFeePerGas: Array(21).fill(0n),
            reward: Array(20).fill([gwei(0.04), gwei(0.05), gwei(0.06)])
          }
        })
      }
    });

    const quote = await adapter.quoteFeeTiers({
      chainId: 56,
      fromAddress: "0x0873fcac83d802f03f1db70714a72efdcf7ce254",
      toAddress: "0xd3115b156bcdcf16ee5c5c08c5ef6d9afd7715d1",
      token: "BNB",
      amountRaw: "1000"
    });

    const expected = (21_000n * gwei(3)).toString();
    expect(quote.low.nativeAmountRaw).toBe(expected);
    expect(quote.medium.nativeAmountRaw).toBe(expected);
    expect(quote.high.nativeAmountRaw).toBe(expected);
    expect(quote.nativeSymbol).toBe("BNB");
  });

  it("uses feeHistory medians when they exceed the floor (tiers produce distinct numbers)", async () => {
    // Eth mainnet congested: priorities 2/5/10 gwei, baseFee 15 gwei.
    // 2× baseFee + priority puts every tier well above ETH's 2 gwei floor,
    // so the floor does not clip and the three tiers stay distinct.
    const baseFee = gwei(15);
    const adapter = evmChainAdapter({
      chainIds: [1],
      transports: {
        1: feeTransport({
          feeHistory: {
            baseFeePerGas: Array(21).fill(baseFee),
            reward: Array(20).fill([gwei(2), gwei(5), gwei(10)])
          },
          estimateGas: 65_000n // ERC-20 transfer gas on mainnet
        })
      }
    });

    const quote = await adapter.quoteFeeTiers({
      chainId: 1,
      fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "USDC",
      amountRaw: "1000000"
    });

    const maxFee = (priority: bigint): bigint => 2n * baseFee + priority;
    expect(quote.low.nativeAmountRaw).toBe((65_000n * maxFee(gwei(2))).toString());
    expect(quote.medium.nativeAmountRaw).toBe((65_000n * maxFee(gwei(5))).toString());
    expect(quote.high.nativeAmountRaw).toBe((65_000n * maxFee(gwei(10))).toString());
    expect(quote.tieringSupported).toBe(true);
  });

  it("falls back to spot eth_maxPriorityFeePerGas + floor when feeHistory is unsupported", async () => {
    // Some self-hosted / private RPCs don't implement eth_feeHistory. The
    // fallback should still produce a quote, still floored.
    const adapter = evmChainAdapter({
      chainIds: [56],
      transports: {
        56: feeTransport({
          feeHistory: "throw",
          maxPriority: gwei(0.05) // classic BSC quiet-mempool value
        })
      }
    });

    const quote = await adapter.quoteFeeTiers({
      chainId: 56,
      fromAddress: "0x0873fcac83d802f03f1db70714a72efdcf7ce254",
      toAddress: "0xd3115b156bcdcf16ee5c5c08c5ef6d9afd7715d1",
      token: "BNB",
      amountRaw: "1000"
    });

    // Floor takes over: 3 gwei × 21000 per tier.
    const expected = (21_000n * gwei(3)).toString();
    expect(quote.medium.nativeAmountRaw).toBe(expected);
  });

  it("applies Polygon's mandatory 25 gwei priority floor", async () => {
    // Polygon Heimdall v2 enforces a 25 gwei minimum priority fee. Any RPC
    // that reports lower must be clamped or the tx is rejected at the
    // network layer.
    const adapter = evmChainAdapter({
      chainIds: [137],
      transports: {
        137: feeTransport({
          feeHistory: {
            baseFeePerGas: Array(21).fill(0n),
            reward: Array(20).fill([gwei(0.1), gwei(0.2), gwei(0.5)])
          },
          estimateGas: 65_000n // ERC-20 transfer gas
        })
      }
    });

    const quote = await adapter.quoteFeeTiers({
      chainId: 137,
      fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "USDC",
      amountRaw: "1000000"
    });

    // With priority floored to 25 gwei and baseFee 0, raw maxFeePerGas = 25
    // gwei; but the maxFee floor is 30 gwei, so all three tiers land at
    // 30 gwei × 65000 gas.
    const expected = (65_000n * gwei(30)).toString();
    expect(quote.low.nativeAmountRaw).toBe(expected);
    expect(quote.medium.nativeAmountRaw).toBe(expected);
    expect(quote.high.nativeAmountRaw).toBe(expected);
  });
});

describe("evmChainAdapter.buildTransfer — fee binding uses the same floor as the quote", () => {
  it("binds BSC native tx maxFeePerGas at the 3 gwei floor when spot RPC reports 0.05 gwei", async () => {
    // Regression test: before the floor, buildTransfer would set
    // maxFeePerGas to ~0.05 gwei, leaving the reservation (1.5× the tiny
    // quote) under the real inclusion cost. With the floor the tx carries a
    // maxFeePerGas matching what was reserved at plan time.
    const adapter = evmChainAdapter({
      chainIds: [56],
      transports: {
        56: feeTransport({
          feeHistory: {
            baseFeePerGas: Array(21).fill(0n),
            reward: Array(20).fill([gwei(0.04), gwei(0.05), gwei(0.06)])
          }
        })
      }
    });

    const unsigned = await adapter.buildTransfer({
      chainId: 56,
      fromAddress: "0x0873fcac83d802f03f1db70714a72efdcf7ce254",
      toAddress: "0xd3115b156bcdcf16ee5c5c08c5ef6d9afd7715d1",
      token: "BNB",
      amountRaw: "1000000000000000",
      feeTier: "medium"
    });
    const raw = unsigned.raw as {
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    };
    expect(raw.maxFeePerGas).toBe(gwei(3));
    expect(raw.maxPriorityFeePerGas).toBe(gwei(3));
  });

  it("binds the floor at broadcast even when the merchant didn't specify a feeTier", async () => {
    // The bug this guards against: a payout planned without an explicit
    // feeTier (common case — merchants don't always pass one) previously
    // left `raw.maxFeePerGas` unset, letting viem's sendTransaction invoke
    // its internal fee calc (baseFeeMultiplier=1.2 + spot priority) which on
    // BSC can return 4+ gwei while the planner's reservation was sized for
    // the 1 gwei floor. buildTransfer now applies the floor for every
    // 1559-supporting call, defaulting to the medium tier (which matches
    // what planPayout uses for the picker budget).
    const adapter = evmChainAdapter({
      chainIds: [56],
      transports: {
        56: feeTransport({
          feeHistory: {
            baseFeePerGas: Array(21).fill(0n),
            reward: Array(20).fill([gwei(0.04), gwei(0.05), gwei(0.06)])
          }
        })
      }
    });

    const unsigned = await adapter.buildTransfer({
      chainId: 56,
      fromAddress: "0x0873fcac83d802f03f1db70714a72efdcf7ce254",
      toAddress: "0xd3115b156bcdcf16ee5c5c08c5ef6d9afd7715d1",
      token: "BNB",
      amountRaw: "1000000000000000"
      // NO feeTier — simulates a `POST /payouts` without an explicit tier,
      // which surfaces at executor time as row.feeTier === null.
    });
    const raw = unsigned.raw as {
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    };
    expect(raw.maxFeePerGas).toBe(gwei(3));
    expect(raw.maxPriorityFeePerGas).toBe(gwei(3));
  });

  it("pre-binds `gas` on the raw tx so viem skips its own eth_estimateGas call", async () => {
    // Regression for the tight-balance BSC scenario: source holds exactly
    // `value + our_gas × our_maxFee` on-chain, so the tx would succeed at
    // mempool but fails at viem's pre-broadcast `eth_estimateGas` call —
    // Alchemy BSC runs that simulation with an internal gas price higher
    // than our bound maxFeePerGas and rejects with "insufficient funds for
    // gas * price + value". By pre-binding `gas` here we force viem to skip
    // its estimateGas call entirely and rely on the actual mempool balance
    // check, which uses our bound maxFeePerGas.
    const adapter = evmChainAdapter({
      chainIds: [56, 1],
      transports: {
        56: feeTransport({
          feeHistory: {
            baseFeePerGas: Array(21).fill(0n),
            reward: Array(20).fill([gwei(0.04), gwei(0.05), gwei(0.06)])
          }
        }),
        1: feeTransport({
          feeHistory: {
            baseFeePerGas: Array(21).fill(gwei(5)),
            reward: Array(20).fill([gwei(1), gwei(2), gwei(3)])
          }
        })
      }
    });

    const native = await adapter.buildTransfer({
      chainId: 56,
      fromAddress: "0x0873fcac83d802f03f1db70714a72efdcf7ce254",
      toAddress: "0xd3115b156bcdcf16ee5c5c08c5ef6d9afd7715d1",
      token: "BNB",
      amountRaw: "1000000000000000",
      feeTier: "medium"
    });
    const nativeRaw = native.raw as { gas?: bigint };
    expect(nativeRaw.gas).toBe(21_000n);

    const erc20 = await adapter.buildTransfer({
      chainId: 1,
      fromAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      toAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      token: "USDC",
      amountRaw: "1000000",
      feeTier: "high"
    });
    const erc20Raw = erc20.raw as { gas?: bigint };
    expect(erc20Raw.gas).toBe(65_000n);
  });
});
