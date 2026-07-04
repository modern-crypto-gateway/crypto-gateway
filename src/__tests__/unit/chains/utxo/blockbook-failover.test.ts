import { describe, expect, it } from "vitest";
import { blockbookClient } from "../../../../adapters/chains/utxo/blockbook-rpc.js";
import {
  compositeEsploraClient,
  EsploraBackendError,
  EsploraNotFoundError,
  type EsploraClient
} from "../../../../adapters/chains/utxo/esplora-rpc.js";

// Blockbook → Esplora projection + cross-shape failover. The Blockbook leg
// exists because public Esplora coverage for LTC is a single instance
// (litecoinspace.org) with a history of 520s — detection must degrade to a
// keyed Blockbook provider (GetBlock/NOWNodes), not stall.

const ADDRESS = "ltc1qq5m9zy96f2wm5cnjva06lqzr373lqhajkhy4mw";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown }
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }) as typeof globalThis.fetch;
}

const BLOCKBOOK_TX = {
  txid: "ab".repeat(32),
  blockHash: "cd".repeat(32),
  blockHeight: 3_100_000,
  confirmations: 4,
  blockTime: 1_750_000_000,
  fees: "2200",
  vin: [
    {
      txid: "12".repeat(32),
      vout: 1,
      n: 0,
      addresses: ["ltc1qsenderaddressxxxxxxxxxxxxxxxxxxxxxxxx"],
      isAddress: true,
      value: "5002200"
    }
  ],
  vout: [
    {
      value: "5000000",
      n: 0,
      hex: "0014abcdef",
      addresses: [ADDRESS],
      isAddress: true
    }
  ]
};

describe("blockbookClient — Esplora-shape projection", () => {
  it("maps a confirmed Blockbook tx (satoshi strings, addresses[]) onto the EsploraTx shape", async () => {
    const client = blockbookClient({
      baseUrl: "https://ltcbook.example",
      fetch: fakeFetch((url) => {
        expect(url).toContain("/api/v2/address/");
        expect(url).toContain("details=txs");
        return { status: 200, body: { transactions: [BLOCKBOOK_TX] } };
      })
    });
    const [tx] = await client.getAddressTxs(ADDRESS);
    expect(tx).toMatchObject({
      txid: BLOCKBOOK_TX.txid,
      status: {
        confirmed: true,
        block_height: 3_100_000,
        block_time: 1_750_000_000
      },
      fee: 2200
    });
    expect(tx!.vout[0]).toMatchObject({
      scriptpubkey: "0014abcdef",
      scriptpubkey_address: ADDRESS,
      value: 5_000_000
    });
    expect(tx!.vin[0]!.prevout?.scriptpubkey_address).toBe(
      "ltc1qsenderaddressxxxxxxxxxxxxxxxxxxxxxxxx"
    );
  });

  it("treats blockHeight -1 / 0 confirmations as mempool and filters them into getAddressMempoolTxs", async () => {
    const unconfirmed = { ...BLOCKBOOK_TX, txid: "ef".repeat(32), blockHeight: -1, confirmations: 0 };
    const client = blockbookClient({
      baseUrl: "https://ltcbook.example",
      fetch: fakeFetch(() => ({
        status: 200,
        body: { transactions: [BLOCKBOOK_TX, unconfirmed] }
      }))
    });
    const mempool = await client.getAddressMempoolTxs(ADDRESS);
    expect(mempool).toHaveLength(1);
    expect(mempool[0]).toMatchObject({ txid: unconfirmed.txid, status: { confirmed: false } });
  });

  it("sends the userinfo API key as the api-key header and strips it from the URL", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const client = blockbookClient({
      baseUrl: "https://MYSECRETKEY@ltcbook.nownodes.example",
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return { status: 200, body: { blockbook: { bestHeight: 123 } } };
      })
    });
    await client.getTipHeight();
    expect(seenUrl).not.toContain("MYSECRETKEY");
    expect(seenHeaders["api-key"]).toBe("MYSECRETKEY");
  });

  it("maps Blockbook 'not found' 400s to EsploraNotFoundError (confirmation sweep retries, not outage)", async () => {
    const client = blockbookClient({
      baseUrl: "https://ltcbook.example",
      fetch: fakeFetch(() => ({
        status: 400,
        body: "Transaction 'deadbeef' not found"
      }))
    });
    await expect(client.getTx("deadbeef")).rejects.toBeInstanceOf(EsploraNotFoundError);
  });
});

describe("compositeEsploraClient — cross-shape failover", () => {
  function stubClient(impl: Partial<EsploraClient>): EsploraClient {
    const reject = async (): Promise<never> => {
      throw new Error("unexpected call");
    };
    return {
      getAddressTxs: reject,
      getAddressMempoolTxs: reject,
      getTx: reject,
      getTipHeight: reject,
      broadcastTx: reject,
      getFeeEstimates: reject,
      getAddressBalanceSats: reject,
      ...impl
    };
  }

  it("falls through to the Blockbook leg when every Esplora backend fails (the litecoinspace-520 scenario)", async () => {
    const primary = stubClient({
      getAddressTxs: async () => {
        throw new EsploraBackendError("https://litecoinspace.org/api", 520, "origin error");
      }
    });
    const failover = stubClient({
      getAddressTxs: async () => []
    });
    const composite = compositeEsploraClient([primary, failover]);
    await expect(composite.getAddressTxs(ADDRESS)).resolves.toEqual([]);
  });

  it("short-circuits on 404/400 — a definitive 'nothing here' must not be retried on the next provider", async () => {
    let failoverCalled = false;
    const primary = stubClient({
      getTx: async () => {
        throw new EsploraNotFoundError("/tx/x");
      }
    });
    const failover = stubClient({
      getTx: async () => {
        failoverCalled = true;
        throw new Error("must not be called");
      }
    });
    const composite = compositeEsploraClient([primary, failover]);
    await expect(composite.getTx("x")).rejects.toBeInstanceOf(EsploraNotFoundError);
    expect(failoverCalled).toBe(false);
  });

  it("throws an aggregate error when every provider fails (checkpoint must not advance)", async () => {
    const boom = stubClient({
      getTipHeight: async () => {
        throw new EsploraBackendError("https://a", 500, "down");
      }
    });
    const alsoBoom = stubClient({
      getTipHeight: async () => {
        throw new EsploraBackendError("https://b", 502, "also down");
      }
    });
    const composite = compositeEsploraClient([boom, alsoBoom]);
    await expect(composite.getTipHeight()).rejects.toThrow(/all 2 providers failed/);
  });
});
