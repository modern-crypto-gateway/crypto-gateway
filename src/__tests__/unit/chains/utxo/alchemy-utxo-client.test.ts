import { describe, expect, it, vi } from "vitest";
import {
  alchemyUtxoClient,
  utxoEsploraClientFor
} from "../../../../adapters/chains/utxo/alchemy-utxo-client.js";
import { utxoChainAdapter } from "../../../../adapters/chains/utxo/utxo-chain.adapter.js";
import { LITECOIN_CONFIG } from "../../../../adapters/chains/utxo/utxo-config.js";
import {
  failoverEsploraClient,
  EsploraBackendError,
  EsploraBadRequestError,
  EsploraNotFoundError,
  type EsploraClient
} from "../../../../adapters/chains/utxo/esplora-rpc.js";

// All responses below mirror the live Blockbook v2 shape captured from
// https://litecoin-mainnet.g.alchemy.com/v2/docs-demo/api/v2 — string-satoshi
// values, addresses[] on vin/vout, blockHeight/blockTime/confirmations/fees.

const WATCHED = "ltc1qd73e63c04a6cbad8d5dc94fdbef5175d2364e3"; // our receive addr
const SENDER = "LNqEYhSgarC9gY6AAdBHyVJvEikQth3eNj";

type FetchArgs = [input: string, init?: { method?: string; body?: unknown }];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

// Build a fake fetch that routes by URL + JSON-RPC method.
function fakeFetch(handlers: {
  address?: (url: string) => Response;
  tx?: (url: string) => Response;
  rpc?: (method: string, params: readonly unknown[]) => Response;
  sendtx?: (hex: string) => Response;
}): typeof globalThis.fetch {
  return (async (...[input, init]: FetchArgs) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/sendtx")) {
      return handlers.sendtx?.(String(init?.body ?? "")) ?? jsonResponse({ error: "no handler" }, 500);
    }
    if (method === "POST") {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      return handlers.rpc?.(parsed.method, parsed.params) ?? jsonResponse({ result: null, error: { message: "no rpc handler" } }, 500);
    }
    if (url.includes("/api/v2/address/")) return handlers.address?.(url) ?? jsonResponse({ transactions: [] });
    if (url.includes("/api/v2/tx/")) return handlers.tx?.(url) ?? jsonResponse({}, 400);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

const CONFIRMED_TX = {
  txid: "d9a5e3a3cb19be98a2ed6a205a22d207892e1c0ba8faf0301abcd94d5f545545",
  version: 2,
  vin: [{ txid: "3e0044", vout: 21, sequence: 4294967295, n: 0, addresses: [SENDER], isAddress: true, value: "2868006" }],
  vout: [
    { value: "100000", n: 0, spent: true, hex: "76a914be78", addresses: ["Lcb4jao9XQ9WQGBW4hcBf7kVUSe5Ze6bsf"], isAddress: true },
    { value: "2718006", n: 1, hex: "76a914d73e", addresses: [WATCHED], isAddress: true }
  ],
  blockHash: "6d1a8eed",
  blockHeight: 2981901,
  confirmations: 150011,
  blockTime: 1759937639,
  value: "2818006",
  valueIn: "2868006",
  fees: "50000"
};

const MEMPOOL_TX = {
  txid: "aaaa1111",
  version: 2,
  vin: [{ txid: "bbbb", vout: 0, addresses: [SENDER], isAddress: true, value: "500000" }],
  vout: [{ value: "499000", n: 0, hex: "76a9", addresses: [WATCHED], isAddress: true }],
  blockHeight: -1,
  confirmations: 0,
  fees: "1000"
};

const addressResponse = (txs: unknown[], balance = "2718006") =>
  jsonResponse({ page: 1, totalPages: 1, address: WATCHED, balance, unconfirmedTxs: 0, txs: txs.length, transactions: txs });

describe("alchemyUtxoClient", () => {
  it("maps a confirmed Blockbook tx to EsploraTx (string-sats → number, addresses)", async () => {
    const client = alchemyUtxoClient({
      subdomain: "litecoin-mainnet",
      apiKey: "k",
      fetch: fakeFetch({ address: () => addressResponse([CONFIRMED_TX]) })
    });
    const txs = await client.getAddressTxs(WATCHED);
    expect(txs).toHaveLength(1);
    const t = txs[0]!;
    expect(t.txid).toBe(CONFIRMED_TX.txid);
    expect(t.status).toMatchObject({ confirmed: true, block_height: 2981901, block_time: 1759937639 });
    expect(t.fee).toBe(50000);
    expect(t.vin[0]?.prevout?.scriptpubkey_address).toBe(SENDER);
    expect(t.vout[1]).toMatchObject({ scriptpubkey_address: WATCHED, value: 2718006 });
    expect(typeof t.vout[1]?.value).toBe("number");
  });

  it("splits confirmed vs mempool across getAddressTxs / getAddressMempoolTxs", async () => {
    const client = alchemyUtxoClient({
      subdomain: "litecoin-mainnet",
      apiKey: "k",
      fetch: fakeFetch({ address: () => addressResponse([MEMPOOL_TX, CONFIRMED_TX]) })
    });
    const confirmed = await client.getAddressTxs(WATCHED);
    const mempool = await client.getAddressMempoolTxs(WATCHED);
    expect(confirmed.map((t) => t.txid)).toEqual([CONFIRMED_TX.txid]);
    expect(mempool.map((t) => t.txid)).toEqual([MEMPOOL_TX.txid]);
    expect(mempool[0]?.status).toEqual({ confirmed: false });
  });

  it("normalizes a 400 from /tx (unknown txid) to EsploraNotFoundError", async () => {
    const client = alchemyUtxoClient({
      subdomain: "litecoin-mainnet",
      apiKey: "k",
      fetch: fakeFetch({ tx: () => jsonResponse({ error: "not found" }, 400) })
    });
    await expect(client.getTx("00ff")).rejects.toBeInstanceOf(EsploraNotFoundError);
  });

  it("reads tip height from JSON-RPC getblockcount", async () => {
    const client = alchemyUtxoClient({
      subdomain: "litecoin-mainnet",
      apiKey: "k",
      fetch: fakeFetch({ rpc: (m) => (m === "getblockcount" ? jsonResponse({ result: 3131916, error: null }) : jsonResponse({ result: null, error: { message: "x" } }, 500)) })
    });
    expect(await client.getTipHeight()).toBe(3131916);
  });

  it("converts estimatesmartfee feerate (coin/kB) to sat/vB, floored at 1", async () => {
    const client = alchemyUtxoClient({
      subdomain: "litecoin-mainnet",
      apiKey: "k",
      fetch: fakeFetch({
        rpc: (m, p) => {
          if (m !== "estimatesmartfee") return jsonResponse({ result: null, error: { message: "x" } }, 500);
          const blocks = p[0] as number;
          // 0.00002 LTC/kB → 2 sat/vB for the fast target; insufficient-data → floor 1
          return jsonResponse({ result: blocks <= 3 ? { feerate: 0.00002, blocks } : { blocks }, error: null });
        }
      })
    });
    const fees = await client.getFeeEstimates();
    expect(fees["1"]).toBe(2);
    expect(fees["1008"]).toBe(1); // no feerate → floored
  });

  it("parses confirmed balance string to bigint", async () => {
    const client = alchemyUtxoClient({
      subdomain: "litecoin-mainnet",
      apiKey: "k",
      fetch: fakeFetch({ address: () => addressResponse([], "2728006") })
    });
    expect(await client.getAddressBalanceSats(WATCHED)).toBe(2728006n);
  });

  it("drives scanIncoming end-to-end: a payment to a watched LTC address is detected", async () => {
    const adapter = utxoChainAdapter({
      chain: LITECOIN_CONFIG,
      esplora: alchemyUtxoClient({
        subdomain: "litecoin-mainnet",
        apiKey: "k",
        fetch: fakeFetch({
          address: () => addressResponse([CONFIRMED_TX]),
          rpc: (m) => (m === "getblockcount" ? jsonResponse({ result: 2981911, error: null }) : jsonResponse({ result: null, error: { message: "x" } }, 500))
        })
      })
    });
    const transfers = await adapter.scanIncoming({
      chainId: LITECOIN_CONFIG.chainId,
      addresses: [WATCHED] as never,
      tokens: ["LTC"] as never,
      sinceMs: 0
    });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      chainId: LITECOIN_CONFIG.chainId,
      txHash: CONFIRMED_TX.txid,
      logIndex: 1,
      toAddress: WATCHED,
      token: "LTC",
      amountRaw: "2718006",
      blockNumber: 2981901,
      confirmations: 11 // 2981911 - 2981901 + 1
    });
  });
});

describe("failoverEsploraClient", () => {
  function stub(over: Partial<EsploraClient>): EsploraClient {
    return {
      getAddressTxs: async () => [],
      getAddressMempoolTxs: async () => [],
      getTx: async () => { throw new EsploraNotFoundError("/tx/x"); },
      getTipHeight: async () => 0,
      broadcastTx: async () => "txid",
      getFeeEstimates: async () => ({}),
      getAddressBalanceSats: async () => 0n,
      ...over
    };
  }

  it("falls over to the next client when the primary throws a backend error", async () => {
    const primary = vi.fn(async () => { throw new EsploraBackendError("alchemy", 520, "down"); });
    const secondaryTip = vi.fn(async () => 999);
    const client = failoverEsploraClient([
      stub({ getTipHeight: primary }),
      stub({ getTipHeight: secondaryTip })
    ]);
    expect(await client.getTipHeight()).toBe(999);
    expect(primary).toHaveBeenCalledOnce();
    expect(secondaryTip).toHaveBeenCalledOnce();
  });

  it("short-circuits on EsploraBadRequestError without trying the fallback", async () => {
    const secondary = vi.fn(async () => [] as never);
    const client = failoverEsploraClient([
      stub({ getAddressTxs: async () => { throw new EsploraBadRequestError("/address/bc1.../txs"); } }),
      stub({ getAddressTxs: secondary })
    ]);
    await expect(client.getAddressTxs("bc1xyz")).rejects.toBeInstanceOf(EsploraBadRequestError);
    expect(secondary).not.toHaveBeenCalled();
  });

  it("rethrows the last error (e.g. NotFound) when every client fails", async () => {
    const client = failoverEsploraClient([
      stub({ getTx: async () => { throw new EsploraBackendError("a", 500, "x"); } }),
      stub({ getTx: async () => { throw new EsploraNotFoundError("/tx/x"); } })
    ]);
    await expect(client.getTx("x")).rejects.toBeInstanceOf(EsploraNotFoundError);
  });
});

describe("utxoEsploraClientFor", () => {
  it("returns Esplora-only when no Alchemy key is provided", () => {
    // Smoke: with no key we still get a usable client (default public Esplora).
    const client = utxoEsploraClientFor(LITECOIN_CONFIG, {});
    expect(typeof client.getAddressTxs).toBe("function");
  });
});
