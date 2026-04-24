import { describe, expect, it, vi } from "vitest";
import {
  tronCompositeClient,
  TronProviderNotSupportedError,
  type TronRpcBackend
} from "../../../../adapters/chains/tron/tron-rpc.js";

function stubBackend(name: string, overrides: Partial<TronRpcBackend>): TronRpcBackend {
  return {
    name,
    supportsDetection: overrides.supportsDetection ?? true,
    listTrc20Transfers:
      overrides.listTrc20Transfers ??
      (async () => {
        throw new Error(`${name}.listTrc20Transfers: unexpected call`);
      }),
    listTrxTransfers:
      overrides.listTrxTransfers ??
      (async () => {
        throw new Error(`${name}.listTrxTransfers: unexpected call`);
      }),
    getTransactionInfo:
      overrides.getTransactionInfo ??
      (async () => {
        throw new Error(`${name}.getTransactionInfo: unexpected call`);
      }),
    getNowBlock:
      overrides.getNowBlock ??
      (async () => {
        throw new Error(`${name}.getNowBlock: unexpected call`);
      }),
    triggerSmartContract:
      overrides.triggerSmartContract ??
      (async () => {
        throw new Error(`${name}.triggerSmartContract: unexpected call`);
      }),
    triggerConstantContract:
      overrides.triggerConstantContract ??
      (async () => {
        throw new Error(`${name}.triggerConstantContract: unexpected call`);
      }),
    getChainParameters:
      overrides.getChainParameters ??
      (async () => {
        throw new Error(`${name}.getChainParameters: unexpected call`);
      }),
    getAccountResources:
      overrides.getAccountResources ??
      (async () => {
        throw new Error(`${name}.getAccountResources: unexpected call`);
      }),
    freezeBalanceV2:
      overrides.freezeBalanceV2 ??
      (async () => {
        throw new Error(`${name}.freezeBalanceV2: unexpected call`);
      }),
    unfreezeBalanceV2:
      overrides.unfreezeBalanceV2 ??
      (async () => {
        throw new Error(`${name}.unfreezeBalanceV2: unexpected call`);
      }),
    delegateResource:
      overrides.delegateResource ??
      (async () => {
        throw new Error(`${name}.delegateResource: unexpected call`);
      }),
    undelegateResource:
      overrides.undelegateResource ??
      (async () => {
        throw new Error(`${name}.undelegateResource: unexpected call`);
      }),
    createTransaction:
      overrides.createTransaction ??
      (async () => {
        throw new Error(`${name}.createTransaction: unexpected call`);
      }),
    broadcastTransaction:
      overrides.broadcastTransaction ??
      (async () => {
        throw new Error(`${name}.broadcastTransaction: unexpected call`);
      }),
    getAccount:
      overrides.getAccount ??
      (async () => {
        throw new Error(`${name}.getAccount: unexpected call`);
      })
  };
}

describe("tronCompositeClient", () => {
  it("uses the primary backend when it succeeds (no fallback invocation)", async () => {
    const primary = stubBackend("primary", {
      getNowBlock: async () => ({ block_header: { raw_data: { number: 100 } } })
    });
    const fallback = stubBackend("fallback", {
      getNowBlock: async () => {
        throw new Error("fallback should not be called");
      }
    });
    const client = tronCompositeClient([primary, fallback]);
    const block = await client.getNowBlock();
    expect(block.block_header.raw_data.number).toBe(100);
  });

  it("falls over to the next backend when primary throws a transient error", async () => {
    const primaryCall = vi.fn(async () => {
      throw new Error("TronGrid returned 429: Too Many Requests");
    });
    const fallback = stubBackend("fallback", {
      getNowBlock: async () => ({ block_header: { raw_data: { number: 200 } } })
    });
    const client = tronCompositeClient([
      stubBackend("primary", { getNowBlock: primaryCall }),
      fallback
    ]);
    const block = await client.getNowBlock();
    expect(primaryCall).toHaveBeenCalledOnce();
    expect(block.block_header.raw_data.number).toBe(200);
  });

  it("skips backends that throw TronProviderNotSupportedError (not-supported, not-a-failure)", async () => {
    // Primary = Alchemy-style: rejects detection explicitly. Composite should
    // skip straight to TronGrid without counting Alchemy as a failure.
    const notSupporting = stubBackend("alchemy-tron", {
      supportsDetection: false,
      listTrc20Transfers: async () => {
        throw new TronProviderNotSupportedError("alchemy-tron", "listTrc20Transfers");
      }
    });
    const supporting = stubBackend("trongrid", {
      listTrc20Transfers: async () => [
        {
          transaction_id: "0xabc",
          block: 1,
          block_timestamp: 1_700_000_000_000,
          from: "Tfrom",
          to: "Tto",
          value: "1000000",
          token_info: {
            address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
            decimals: 6,
            name: "Tether",
            symbol: "USDT"
          },
          type: "Transfer"
        }
      ]
    });
    const client = tronCompositeClient([notSupporting, supporting]);
    const transfers = await client.listTrc20Transfers("Tto");
    expect(transfers).toHaveLength(1);
  });

  it("rethrows TronProviderNotSupportedError when EVERY backend declines", async () => {
    const a = stubBackend("a", {
      supportsDetection: false,
      listTrc20Transfers: async () => {
        throw new TronProviderNotSupportedError("a", "listTrc20Transfers");
      }
    });
    const b = stubBackend("b", {
      supportsDetection: false,
      listTrc20Transfers: async () => {
        throw new TronProviderNotSupportedError("b", "listTrc20Transfers");
      }
    });
    const client = tronCompositeClient([a, b]);
    await expect(client.listTrc20Transfers("Tany")).rejects.toBeInstanceOf(
      TronProviderNotSupportedError
    );
  });

  it("rethrows the last non-NotSupported error when every backend that tried failed", async () => {
    const a = stubBackend("a", {
      getNowBlock: async () => {
        throw new Error("a: connection reset");
      }
    });
    const b = stubBackend("b", {
      getNowBlock: async () => {
        throw new Error("b: 503 Service Unavailable");
      }
    });
    const client = tronCompositeClient([a, b]);
    await expect(client.getNowBlock()).rejects.toThrow(/503 Service Unavailable/);
  });

  it("emits onBackendSkipped for each failover so operators can observe provider health", async () => {
    const events: Array<{ backend: string; method: string; reason: string }> = [];
    const a = stubBackend("a", {
      getNowBlock: async () => {
        throw new Error("a: 429");
      }
    });
    const b = stubBackend("b", {
      getNowBlock: async () => ({ block_header: { raw_data: { number: 7 } } })
    });
    const client = tronCompositeClient([a, b], {
      onBackendSkipped: (ev) => events.push(ev)
    });
    await client.getNowBlock();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ backend: "a", method: "getNowBlock" });
    expect(events[0]?.reason).toMatch(/429/);
  });

  it("aggregates supportsDetection = OR across all backends", () => {
    const detectionOnly = stubBackend("t", { supportsDetection: true });
    const walletOnly = stubBackend("a", { supportsDetection: false });
    expect(tronCompositeClient([walletOnly, detectionOnly]).supportsDetection).toBe(true);
    expect(tronCompositeClient([walletOnly]).supportsDetection).toBe(false);
  });
});
