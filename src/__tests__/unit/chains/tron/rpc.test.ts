import { describe, expect, it } from "vitest";
import { tronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../../../adapters/chains/tron/tron-chain.adapter.js";
import type { TronRpcBackend } from "../../../../adapters/chains/tron/tron-rpc.js";
import { tronToEvmCoreHex } from "../../../../adapters/chains/tron/tron-address.js";

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
    async listTrxTransfers() {
      throw new Error("unexpected listTrxTransfers call");
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
    async triggerConstantContract() {
      throw new Error("unexpected triggerConstantContract call");
    },
    async getChainParameters() {
      throw new Error("unexpected getChainParameters call");
    },
    async getAccountResources() {
      throw new Error("unexpected getAccountResources call");
    },
    async freezeBalanceV2() {
      throw new Error("unexpected freezeBalanceV2 call");
    },
    async unfreezeBalanceV2() {
      throw new Error("unexpected unfreezeBalanceV2 call");
    },
    async delegateResource() {
      throw new Error("unexpected delegateResource call");
    },
    async undelegateResource() {
      throw new Error("unexpected undelegateResource call");
    },
    async createTransaction() {
      throw new Error("unexpected createTransaction call");
    },
    async broadcastTransaction() {
      throw new Error("unexpected broadcastTransaction call");
    },
    async getAccount() {
      throw new Error("unexpected getAccount call");
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

  it("detects native TRX incoming via listTrxTransfers and canonicalizes hex addresses", async () => {
    const toAddr = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const fromAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    // TronGrid emits hex 41-prefix addresses; the adapter must convert back
    // to base58check before matching against the watched-address set.
    const toHex = "41" + tronToEvmCoreHex(toAddr).slice(2);
    const fromHex = "41" + tronToEvmCoreHex(fromAddr).slice(2);

    const client = fakeClient({
      async listTrxTransfers(address, opts) {
        expect(address).toBe(toAddr);
        expect(opts?.limit).toBe(200);
        return [
          {
            txID: "cd".repeat(32),
            blockNumber: 55_111_111,
            blockTimestamp: 1_700_000_000_000,
            from: fromHex,
            to: toHex,
            value: "5000000" // 5 TRX (6 decimals)
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
      tokens: ["TRX"],
      sinceMs: Date.now() - 60_000
    });

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      chainId: TRON_MAINNET_CHAIN_ID,
      txHash: "cd".repeat(32),
      logIndex: null,
      fromAddress: fromAddr,
      toAddress: toAddr,
      token: "TRX",
      amountRaw: "5000000",
      blockNumber: 55_111_111,
      confirmations: 0
    });
  });

  it("drops native transfers whose `to` (after hex→base58) is not watched", async () => {
    const ourAddr = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const strangerAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    const strangerHex = "41" + tronToEvmCoreHex(strangerAddr).slice(2);

    const client = fakeClient({
      async listTrxTransfers() {
        return [
          {
            txID: "ee".repeat(32),
            blockNumber: 55_111_222,
            blockTimestamp: 1_700_000_000_000,
            from: strangerHex,
            to: strangerHex,
            value: "1000000"
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
      tokens: ["TRX"],
      sinceMs: Date.now() - 60_000
    });

    expect(transfers).toEqual([]);
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

  it("drops dust native TRX address-poisoning spam (amount=0 and amount=1 sun) but keeps the real payment", async () => {
    const toAddr = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const attackerAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    const realSenderAddr = "TPr9ZWE1jPWT3QjXEBYF89RY8FKGnrS4pC";
    const toHex = "41" + tronToEvmCoreHex(toAddr).slice(2);
    const attackerHex = "41" + tronToEvmCoreHex(attackerAddr).slice(2);
    const realSenderHex = "41" + tronToEvmCoreHex(realSenderAddr).slice(2);

    const client = fakeClient({
      async listTrxTransfers() {
        return [
          // Classic zero-value spam — dropped by threshold.
          { txID: "aa".repeat(32), blockNumber: 55_111_110, blockTimestamp: 1_700_000_000_000, from: attackerHex, to: toHex, value: "0" },
          // One-sun spam (the evolved pattern that defeats a naive "> 0" filter).
          { txID: "cc".repeat(32), blockNumber: 55_111_112, blockTimestamp: 1_700_000_000_000, from: attackerHex, to: toHex, value: "1" },
          // Legitimate 5 TRX payment — must be kept.
          { txID: "bb".repeat(32), blockNumber: 55_111_111, blockTimestamp: 1_700_000_000_000, from: realSenderHex, to: toHex, value: "5000000" }
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
      tokens: ["TRX"],
      sinceMs: Date.now() - 60_000
    });

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ txHash: "bb".repeat(32), amountRaw: "5000000" });
  });

  it("keeps the real payment exactly at the dust threshold (0.001 TRX = 1000 sun)", async () => {
    const toAddr = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const fromAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    const toHex = "41" + tronToEvmCoreHex(toAddr).slice(2);
    const fromHex = "41" + tronToEvmCoreHex(fromAddr).slice(2);

    const client = fakeClient({
      async listTrxTransfers() {
        return [
          // One sun below threshold — must be dropped.
          { txID: "aa".repeat(32), blockNumber: 55_111_110, blockTimestamp: 1_700_000_000_000, from: fromHex, to: toHex, value: "999" },
          // Exactly at threshold — must be kept (boundary inclusive).
          { txID: "bb".repeat(32), blockNumber: 55_111_111, blockTimestamp: 1_700_000_000_000, from: fromHex, to: toHex, value: "1000" }
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
      tokens: ["TRX"],
      sinceMs: Date.now() - 60_000
    });

    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.amountRaw).toBe("1000");
  });

  it("coerces missing `block` on unconfirmed TRC-20 txs to null (not undefined) so Zod accepts them", async () => {
    // TronGrid's /trc20 endpoint has no `only_confirmed` filter — an
    // in-flight USDT tx (seconds-old, already broadcast, not yet in a
    // block) comes back without a `block` field. Before the fix, passing
    // `t.block === undefined` through to DetectedTransfer's Zod schema
    // (`blockNumber: number().nullable()`) failed with "expected number,
    // received undefined" — treating undefined ≠ null — and aborted the
    // entire scan batch. Regression guard for that path.
    const toAddr = "TK5uF5h3S7UG5VvFPY5akChfMSUwcgsh41";
    const fromAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    const client = fakeClient({
      async listTrc20Transfers() {
        return [
          {
            transaction_id: "ab".repeat(32),
            block_timestamp: 1_700_000_000_000,
            // `block` intentionally omitted — now legal under the optional
            // typing of TrongridTrc20Transfer.block.
            from: fromAddr,
            to: toAddr,
            value: "8500000", // 8.5 USDT
            token_info: { address: USDT_TRON_CONTRACT, decimals: 6, name: "Tether USD", symbol: "USDT" },
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
    // `null` (not `undefined`) — passes `DetectedTransferSchema.blockNumber`.
    expect(transfers[0]?.blockNumber).toBeNull();
    expect(transfers[0]?.amountRaw).toBe("8500000");
  });

  it("drops dust TRC-20 spam (amount=0 and amount=1 USDT base unit) but keeps the real payment", async () => {
    const toAddr = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const attackerAddr = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    const realSenderAddr = "TPr9ZWE1jPWT3QjXEBYF89RY8FKGnrS4pC";

    const client = fakeClient({
      async listTrc20Transfers() {
        return [
          { transaction_id: "aa".repeat(32), block_timestamp: 1_700_000_000_000, block: 55_000_000, from: attackerAddr, to: toAddr, value: "0", token_info: { address: USDT_TRON_CONTRACT, decimals: 6, name: "", symbol: "USDT" }, type: "Transfer" },
          { transaction_id: "cc".repeat(32), block_timestamp: 1_700_000_000_000, block: 55_000_002, from: attackerAddr, to: toAddr, value: "1", token_info: { address: USDT_TRON_CONTRACT, decimals: 6, name: "", symbol: "USDT" }, type: "Transfer" },
          { transaction_id: "bb".repeat(32), block_timestamp: 1_700_000_000_000, block: 55_000_001, from: realSenderAddr, to: toAddr, value: "1000000", token_info: { address: USDT_TRON_CONTRACT, decimals: 6, name: "", symbol: "USDT" }, type: "Transfer" }
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
    expect(transfers[0]).toMatchObject({ txHash: "bb".repeat(32), amountRaw: "1000000" });
  });
});

describe("tronChainAdapter.getAccountBalances", () => {
  it("reads TRC-20 balances via balanceOf (triggerConstantContract), not the indexed /v1/accounts trc20 list", async () => {
    // Models the real bug we observed: TronGrid's /v1/accounts/{addr}
    // returns a balanceSun value (authoritative) but omits the USDT entry
    // from the `trc20` array (lagging secondary index). Pre-fix code
    // surfaced 0 USDT for this address. Post-fix, balanceOf returns the
    // correct value regardless of what /v1/accounts said.
    const addr = "TGEn5Z3oktHonC4M2rqpH8DvNi6g3wR4At";
    // 4.641 USDT = 4_641_000 base units. uint256 hex, no 0x prefix, 64 chars.
    const usdtRaw = 4_641_000n;
    const usdtHex = usdtRaw.toString(16).padStart(64, "0");

    const constantCalls: string[] = [];
    const client = fakeClient({
      async getAccount() {
        // balanceSun correct; trc20 deliberately empty (the bug scenario).
        return { balanceSun: "10000000", trc20: {} };
      },
      async triggerConstantContract(params) {
        constantCalls.push(params.contract_address);
        // The adapter issues one call per registered TRC-20 on this chain.
        // We return non-zero for the FIRST call (USDT per registry order)
        // and zero for the rest (USDC). This keeps the assertion tight
        // without caring about the hex form of contract addresses.
        if (constantCalls.length === 1) {
          return { result: { result: true }, constant_result: [usdtHex] };
        }
        return { result: { result: true }, constant_result: ["0".repeat(64)] };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });

    const balances = await adapter.getAccountBalances({
      chainId: TRON_MAINNET_CHAIN_ID,
      address: addr
    });

    const trx = balances.find((b) => b.token === "TRX");
    expect(trx?.amountRaw).toBe("10000000"); // 10 TRX from /v1/accounts.

    const usdt = balances.find((b) => b.token === "USDT");
    expect(usdt?.amountRaw).toBe("4641000");

    // Exactly N balanceOf calls, one per registered TRC-20 on chain.
    // Registry has USDT + USDC on Tron mainnet, so N=2.
    expect(constantCalls.length).toBe(2);
  });

  it("tolerates a per-token balanceOf failure: records 0 for that token and keeps the rest", async () => {
    const addr = "TLBq4D6nxz5wH6fm8am41mEnynK5F7Q6nC";
    let callCount = 0;
    const client = fakeClient({
      async getAccount() {
        return { balanceSun: "0", trc20: {} };
      },
      async triggerConstantContract() {
        callCount += 1;
        if (callCount === 1) throw new Error("simulated RPC 500");
        return { result: { result: true }, constant_result: ["0".repeat(64)] };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });

    const balances = await adapter.getAccountBalances({
      chainId: TRON_MAINNET_CHAIN_ID,
      address: addr
    });

    // TRX + USDT (failed, recorded as 0) + USDC = 3 rows. No throw.
    expect(balances.length).toBe(3);
    expect(balances.every((b) => b.amountRaw === "0")).toBe(true);
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

describe("tronChainAdapter.estimateGasForTransfer — TRC-20 simulation failure", () => {
  // Energy estimation now runs via /wallet/triggerconstantcontract (true VM
  // simulation) rather than /wallet/triggersmartcontract (tx builder, which
  // returned energy_used=0 and caused the planner to quote ~$0 fees for
  // txs that actually burned 12-27 TRX of energy and reverted on-chain).
  it("throws with the revert reason when the TronGrid simulation reports result.result !== true", async () => {
    const client = fakeClient({
      async triggerConstantContract() {
        return {
          energy_used: 0,
          result: { result: false, message: "VM error: CONTRACT_VALIDATE_ERROR" }
        };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    await expect(
      adapter.estimateGasForTransfer({
        chainId: TRON_MAINNET_CHAIN_ID,
        fromAddress: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        token: "USDT" as unknown as never,
        amountRaw: "1000000" as unknown as never
      })
    ).rejects.toThrow(/Tron simulation failed: VM error/);
  });

  it("propagates the revert through quoteFeeTiers (no silent $0 quote)", async () => {
    const client = fakeClient({
      async triggerConstantContract() {
        return {
          result: { result: false, message: "VM error: CALL_VALUE_TRANSFER_FAILED" }
        };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    await expect(
      adapter.quoteFeeTiers({
        chainId: TRON_MAINNET_CHAIN_ID,
        fromAddress: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        token: "USDT" as unknown as never,
        amountRaw: "1000000" as unknown as never
      })
    ).rejects.toThrow(/Tron simulation failed/);
  });

  it("quotes an energy-inclusive fee using the chain's live SUN-per-energy rate", async () => {
    // Regression for two stacked bugs that caused USDT payouts to revert on
    // under-funded sources:
    //   (1) pre-fix we called triggerSmartContract which returned
    //       energy_used=0, making the fee quote ~345 000 sun (bandwidth only);
    //   (2) the energy burn rate was hardcoded to 420 SUN/unit — Tron's
    //       pre-2024 value — and silently doubled quotes after the SR vote
    //       halved the rate to 210.
    // Both paths now run via triggerConstantContract (real VM sim) and
    // getChainParameters (live rate), so the quote tracks what the chain
    // actually charges.
    const client = fakeClient({
      async triggerConstantContract() {
        return {
          energy_used: 32_000,
          result: { result: true },
          constant_result: []
        };
      },
      async getChainParameters() {
        return { params: { getEnergyFee: 210 } };
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const quote = await adapter.quoteFeeTiers({
      chainId: TRON_MAINNET_CHAIN_ID,
      fromAddress: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
      toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      token: "USDT" as unknown as never,
      amountRaw: "1000000" as unknown as never
    });
    // 32 000 energy × 210 SUN + 345 bytes × 1000 SUN = 6 720 000 + 345 000 = 7 065 000 sun.
    expect(quote.medium.nativeAmountRaw).toBe("7065000");
    expect(quote.nativeSymbol).toBe("TRX");
  });

  it("falls back to the 210 SUN/energy default when getChainParameters fails", async () => {
    // RPC flap on /wallet/getchainparameters must NOT block a fee quote —
    // degrade to the fallback (also 210 today, so no under-quoting) rather
    // than erroring out of /payouts/estimate entirely.
    const client = fakeClient({
      async triggerConstantContract() {
        return { energy_used: 32_000, result: { result: true }, constant_result: [] };
      },
      async getChainParameters() {
        throw new Error("trongrid 503");
      }
    });
    const adapter = tronChainAdapter({
      chainIds: [TRON_MAINNET_CHAIN_ID],
      clients: { [TRON_MAINNET_CHAIN_ID]: client }
    });
    const quote = await adapter.quoteFeeTiers({
      chainId: TRON_MAINNET_CHAIN_ID,
      fromAddress: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
      toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      token: "USDT" as unknown as never,
      amountRaw: "1000000" as unknown as never
    });
    expect(quote.medium.nativeAmountRaw).toBe("7065000");
  });
});
