import { describe, expect, it } from "vitest";
import { utxoChainAdapter } from "../../../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../../../adapters/chains/utxo/utxo-config.js";
import type {
  EsploraClient,
  EsploraTx
} from "../../../../adapters/chains/utxo/esplora-rpc.js";
import {
  EsploraNotFoundError
} from "../../../../adapters/chains/utxo/esplora-rpc.js";

// scanIncoming + getConfirmationStatus + getConsumedNativeFee tests against
// a hand-rolled fake Esplora client. We don't hit the network; we feed
// projection logic directly. Keeps the test instant, deterministic, and
// doesn't depend on mempool.space being up.

function fakeClient(impl: Partial<EsploraClient>): EsploraClient {
  return {
    async getAddressTxs() {
      return [];
    },
    async getAddressMempoolTxs() {
      return [];
    },
    async getTx() {
      throw new EsploraNotFoundError("/tx/0xfake");
    },
    async getTipHeight() {
      return 0;
    },
    ...impl
  };
}

const WATCHED = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"; // BIP84 vector address
const OTHER = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"; // BIP84 vector index 1

function tx(over: Partial<EsploraTx>): EsploraTx {
  return {
    txid: "deadbeef",
    status: { confirmed: true, block_height: 100, block_time: 1_700_000_000 },
    vin: [{ txid: "input1", vout: 0, prevout: { scriptpubkey: "00", scriptpubkey_address: "bc1qfrom", value: 50_000_000 }, witness: [], sequence: 0 }],
    vout: [{ scriptpubkey: "0014abc", scriptpubkey_address: WATCHED, value: 10_000_000 }],
    fee: 1_000,
    ...over
  };
}

describe("utxoChainAdapter.scanIncoming", () => {
  it("emits a DetectedTransfer per output paying the watched address", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressTxs(_addr) {
          return [tx({ txid: "abc1" })];
        },
        async getTipHeight() {
          return 105;
        }
      })
    });
    const transfers = await adapter.scanIncoming({
      chainId: 800 as never,
      addresses: [WATCHED] as never,
      tokens: ["BTC"] as never,
      sinceMs: 0
    });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      chainId: 800,
      txHash: "abc1",
      logIndex: 0,
      toAddress: WATCHED,
      token: "BTC",
      amountRaw: "10000000",
      blockNumber: 100,
      confirmations: 6 // 105 - 100 + 1
    });
  });

  it("returns empty when caller does not request the native token", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressTxs() {
          throw new Error("must not poll when token list excludes native");
        }
      })
    });
    const transfers = await adapter.scanIncoming({
      chainId: 800 as never,
      addresses: [WATCHED] as never,
      tokens: ["USDC"] as never,
      sinceMs: 0
    });
    expect(transfers).toEqual([]);
  });

  it("filters out outputs that don't pay any of OUR addresses", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressTxs() {
          return [
            tx({
              vout: [
                { scriptpubkey: "0014a", scriptpubkey_address: WATCHED, value: 10_000 },
                // Change output paying back to the sender — must NOT credit us.
                { scriptpubkey: "0014b", scriptpubkey_address: OTHER, value: 90_000 }
              ]
            })
          ];
        },
        async getTipHeight() {
          return 100;
        }
      })
    });
    const transfers = await adapter.scanIncoming({
      chainId: 800 as never,
      addresses: [WATCHED] as never,
      tokens: ["BTC"] as never,
      sinceMs: 0
    });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.toAddress).toBe(WATCHED);
  });

  it("filters confirmed txs older than sinceMs by block_time", async () => {
    const old = tx({ txid: "old", status: { confirmed: true, block_height: 50, block_time: 1_500_000_000 } });
    const recent = tx({ txid: "recent", status: { confirmed: true, block_height: 60, block_time: 1_700_000_000 } });
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressTxs() {
          return [old, recent];
        },
        async getTipHeight() {
          return 70;
        }
      })
    });
    const transfers = await adapter.scanIncoming({
      chainId: 800 as never,
      addresses: [WATCHED] as never,
      tokens: ["BTC"] as never,
      sinceMs: 1_600_000_000_000 // 1.6e12 ms = 1.6e9 sec → drops the older tx
    });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.txHash).toBe("recent");
  });

  it("includes mempool (unconfirmed) txs with confirmations=0 and blockNumber=null", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressMempoolTxs() {
          return [tx({ txid: "pending", status: { confirmed: false } })];
        },
        async getTipHeight() {
          return 100;
        }
      })
    });
    const transfers = await adapter.scanIncoming({
      chainId: 800 as never,
      addresses: [WATCHED] as never,
      tokens: ["BTC"] as never,
      sinceMs: 0
    });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      txHash: "pending",
      blockNumber: null,
      confirmations: 0
    });
  });

  it("emits one DetectedTransfer per output when a tx pays the watched address twice", async () => {
    // Rare but legal — sender splits a payment across two outputs to the
    // same recipient. Each is a separate UTXO, so each gets its own row.
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressTxs() {
          return [
            tx({
              vout: [
                { scriptpubkey: "0014a", scriptpubkey_address: WATCHED, value: 10_000 },
                { scriptpubkey: "0014b", scriptpubkey_address: WATCHED, value: 25_000 }
              ]
            })
          ];
        },
        async getTipHeight() {
          return 100;
        }
      })
    });
    const transfers = await adapter.scanIncoming({
      chainId: 800 as never,
      addresses: [WATCHED] as never,
      tokens: ["BTC"] as never,
      sinceMs: 0
    });
    expect(transfers).toHaveLength(2);
    expect(transfers.map((t) => t.logIndex).sort()).toEqual([0, 1]);
    expect(transfers.map((t) => t.amountRaw).sort()).toEqual(["10000", "25000"]);
  });
});

describe("utxoChainAdapter.getConfirmationStatus", () => {
  it("reports confirmations from the receipt block_height + tip", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getTx() {
          return tx({ txid: "abc1", status: { confirmed: true, block_height: 100, block_time: 1 } });
        },
        async getTipHeight() {
          return 112;
        }
      })
    });
    const status = await adapter.getConfirmationStatus(800 as never, "abc1" as never);
    expect(status).toEqual({ blockNumber: 100, confirmations: 13, reverted: false });
  });

  it("reports zero confirmations + reverted=false when the tx is unconfirmed (mempool only)", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getTx() {
          return tx({ status: { confirmed: false } });
        }
      })
    });
    const status = await adapter.getConfirmationStatus(800 as never, "pending" as never);
    expect(status).toEqual({ blockNumber: null, confirmations: 0, reverted: false });
  });

  it("treats not-found as zero confirmations (caller retries on a later tick)", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getTx() {
          throw new EsploraNotFoundError("/tx/abc");
        }
      })
    });
    const status = await adapter.getConfirmationStatus(800 as never, "abc" as never);
    expect(status).toEqual({ blockNumber: null, confirmations: 0, reverted: false });
  });
});

describe("utxoChainAdapter.getConsumedNativeFee", () => {
  it("returns the tx's fee field as a sats decimal string", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getTx() {
          return tx({ fee: 4_321 });
        }
      })
    });
    const fee = await adapter.getConsumedNativeFee(800 as never, "abc" as never);
    expect(fee).toBe("4321");
  });

  it("returns null when the tx isn't found (mempool eviction or pre-broadcast)", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getTx() {
          throw new EsploraNotFoundError("/tx/abc");
        }
      })
    });
    const fee = await adapter.getConsumedNativeFee(800 as never, "abc" as never);
    expect(fee).toBeNull();
  });
});
