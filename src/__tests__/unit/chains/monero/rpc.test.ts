import { describe, expect, it } from "vitest";
import { moneroDaemonRpcClient } from "../../../../adapters/chains/monero/monero-rpc.js";

// Monero daemon RPC client behavior tests: endpoint routing, response
// parsing (block / txpool / tx as_json), sticky failover, and the keyed
// fallback backend's header isolation. All network I/O goes through an
// injected fake fetch — no real daemon is contacted.

const BACKEND_A = "https://a.example";
const BACKEND_B = "https://b.example";
const FALLBACK = "https://fallback.example";

// Recording fetch stub. The handler decides the response per URL (throw to
// simulate a network-level failure); every attempt — including failed ones —
// is captured in `calls` so tests can assert failover order and headers.
function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown }
): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null
    });
    const { status, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// JSON-RPC envelope for /json_rpc responses (raw endpoints return the body
// object directly).
function jsonRpcOk(result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: "2.0", id: "0", result } };
}

// Minimal-but-valid `as_json` payload: one primary tx pubkey (extra tag
// 0x01 + 32 bytes), tagged_key outputs with view tags, RingCT ecdhInfo
// amounts + outPk commitments. Third output uses the pre-v15 bare `key`
// target with no matching ecdhInfo/outPk entries.
const TX_PUBKEY_HEX = "ab".repeat(32);
const HAPPY_AS_JSON = JSON.stringify({
  extra: [1, ...Array<number>(32).fill(0xab)],
  unlock_time: 0,
  vin: [{ key: {} }],
  vout: [
    { target: { tagged_key: { key: "cc".repeat(32), view_tag: "a7" } } },
    { target: { tagged_key: { key: "dd".repeat(32), view_tag: "00" } } },
    { target: { key: "11".repeat(32) } }
  ],
  rct_signatures: {
    ecdhInfo: [{ amount: "1122334455667788" }, { amount: "8877665544332211" }],
    outPk: ["ee".repeat(32), "ff".repeat(32)]
  }
});

describe("moneroDaemonRpcClient — getTxPoolHashes", () => {
  it("POSTs /get_transaction_pool_hashes and returns tx_hashes", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { status: "OK", tx_hashes: ["hash1", "hash2"] }
    }));
    const client = moneroDaemonRpcClient({ backends: [{ baseUrl: BACKEND_A }], fetch });
    await expect(client.getTxPoolHashes()).resolves.toEqual(["hash1", "hash2"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BACKEND_A}/get_transaction_pool_hashes`);
  });

  it("returns [] when the daemon omits tx_hashes (empty pool)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { status: "OK" } }));
    const client = moneroDaemonRpcClient({ backends: [{ baseUrl: BACKEND_A }], fetch });
    await expect(client.getTxPoolHashes()).resolves.toEqual([]);
  });
});

describe("moneroDaemonRpcClient — getBlockByHeight", () => {
  it("collects miner_tx_hash + tx_hashes and the block-header timestamp", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonRpcOk({
        miner_tx_hash: "miner-tx",
        tx_hashes: ["tx1", "tx2"],
        block_header: { timestamp: 1_751_700_000 }
      })
    );
    const client = moneroDaemonRpcClient({ backends: [{ baseUrl: BACKEND_A }], fetch });
    const block = await client.getBlockByHeight(350);
    expect(block.txHashes).toEqual(["miner-tx", "tx1", "tx2"]);
    expect(block.timestampSec).toBe(1_751_700_000);
    expect(calls[0]!.url).toBe(`${BACKEND_A}/json_rpc`);
    expect(calls[0]!.body).toMatchObject({ method: "get_block", params: { height: 350 } });
  });

  it("returns timestampSec null when the header timestamp is absent", async () => {
    const { fetch } = fakeFetch(() => jsonRpcOk({ miner_tx_hash: "miner-tx", tx_hashes: [] }));
    const client = moneroDaemonRpcClient({ backends: [{ baseUrl: BACKEND_A }], fetch });
    const block = await client.getBlockByHeight(1);
    expect(block.txHashes).toEqual(["miner-tx"]);
    expect(block.timestampSec).toBeNull();
  });
});

describe("moneroDaemonRpcClient — getTransactions", () => {
  it("parses txPubkey, view tags, output keys, ecdh amounts, and commitments from as_json", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        txs: [{ tx_hash: "th1", block_height: 3_400_000, in_pool: false, as_json: HAPPY_AS_JSON }]
      }
    }));
    const client = moneroDaemonRpcClient({ backends: [{ baseUrl: BACKEND_A }], fetch });
    const txs = await client.getTransactions(["th1"]);
    expect(calls[0]!.url).toBe(`${BACKEND_A}/get_transactions`);
    expect(calls[0]!.body).toEqual({ txs_hashes: ["th1"], decode_as_json: true });
    expect(txs).toHaveLength(1);
    const tx = txs[0]!;
    expect(tx.txHash).toBe("th1");
    expect(tx.blockHeight).toBe(3_400_000);
    expect(tx.txPubkey).toBe(TX_PUBKEY_HEX);
    expect(tx.additionalPubkeys).toEqual([]);
    expect(tx.isCoinbase).toBe(false);
    expect(tx.unlockTime).toBe(0);
    expect(tx.outputs).toEqual([
      {
        publicKey: "cc".repeat(32),
        encryptedAmount: "1122334455667788",
        commitment: "ee".repeat(32),
        viewTag: 0xa7 // "a7" → 167
      },
      {
        publicKey: "dd".repeat(32),
        encryptedAmount: "8877665544332211",
        commitment: "ff".repeat(32),
        viewTag: 0
      },
      // Pre-v15 bare `key` target: no view tag, no RingCT entries at index 2.
      {
        publicKey: "11".repeat(32),
        encryptedAmount: null,
        commitment: null,
        viewTag: null
      }
    ]);
  });

  it("tolerates absent tx RECORDS (evicted pool txs) without failing over", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      // Daemon knows only one of the two requested hashes — legitimate.
      body: { txs: [{ tx_hash: "th1", in_pool: true, as_json: HAPPY_AS_JSON }] }
    }));
    const client = moneroDaemonRpcClient({
      backends: [{ baseUrl: BACKEND_A }, { baseUrl: BACKEND_B }],
      fetch
    });
    const txs = await client.getTransactions(["th1", "gone"]);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.blockHeight).toBeNull(); // in_pool → mempool
    expect(calls).toHaveLength(1); // no failover for a missing record
  });

  it("fails over when a backend returns a tx record without as_json (restricted proxy)", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.startsWith(BACKEND_A)) {
        // Record present but as_json stripped — this backend can't decode.
        return { status: 200, body: { txs: [{ tx_hash: "th1", in_pool: false, block_height: 1 }] } };
      }
      return {
        status: 200,
        body: {
          txs: [{ tx_hash: "th1", block_height: 3_400_000, in_pool: false, as_json: HAPPY_AS_JSON }]
        }
      };
    });
    const client = moneroDaemonRpcClient({
      backends: [{ baseUrl: BACKEND_A }, { baseUrl: BACKEND_B }],
      fetch
    });
    const txs = await client.getTransactions(["th1"]);
    // Both backends were tried; the parsed result came from B.
    expect(calls.map((c) => c.url)).toEqual([
      `${BACKEND_A}/get_transactions`,
      `${BACKEND_B}/get_transactions`
    ]);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.blockHeight).toBe(3_400_000);
    expect(txs[0]!.txPubkey).toBe(TX_PUBKEY_HEX);
  });
});

describe("moneroDaemonRpcClient — sticky failover", () => {
  it("remembers the last healthy backend and starts there on the next call", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.startsWith(BACKEND_A)) throw new Error("ECONNREFUSED");
      return jsonRpcOk({ count: 101 });
    });
    const client = moneroDaemonRpcClient({
      backends: [{ baseUrl: BACKEND_A }, { baseUrl: BACKEND_B }],
      fetch
    });
    // First call walks A (dead) → B. get_block_count returns chain LENGTH;
    // the client subtracts 1 for the tip height.
    await expect(client.getTipHeight()).resolves.toBe(100);
    // Second call must go straight to B — no timeout tax on the dead head.
    await expect(client.getTipHeight()).resolves.toBe(100);
    expect(calls.map((c) => c.url)).toEqual([
      `${BACKEND_A}/json_rpc`,
      `${BACKEND_B}/json_rpc`,
      `${BACKEND_B}/json_rpc`
    ]);
  });
});

describe("moneroDaemonRpcClient — keyed fallback backend", () => {
  it("uses the fallback only after all primaries fail, with ITS OWN headers", async () => {
    let primariesUp = false;
    const { fetch, calls } = fakeFetch((url) => {
      if (url.startsWith(FALLBACK)) {
        return { status: 200, body: { tx_hashes: ["from-fallback"] } };
      }
      if (!primariesUp) return { status: 503, body: "unavailable" };
      return { status: 200, body: { tx_hashes: ["from-primary"] } };
    });
    const client = moneroDaemonRpcClient({
      backends: [{ baseUrl: BACKEND_A }, { baseUrl: BACKEND_B }],
      fallbackBackend: { baseUrl: FALLBACK, headers: { "api-key": "SECRET" } },
      fetch
    });

    await expect(client.getTxPoolHashes()).resolves.toEqual(["from-fallback"]);
    expect(calls.map((c) => c.url)).toEqual([
      `${BACKEND_A}/get_transaction_pool_hashes`,
      `${BACKEND_B}/get_transaction_pool_hashes`,
      `${FALLBACK}/get_transaction_pool_hashes`
    ]);
    // The API key must reach ONLY the fallback — never public nodes.
    for (const call of calls) {
      if (call.url.startsWith(FALLBACK)) {
        expect(call.headers["api-key"]).toBe("SECRET");
      } else {
        expect(call.headers["api-key"]).toBeUndefined();
      }
    }

    // Fallback success must NOT become the preferred backend: once a
    // primary recovers, traffic returns to the public fleet.
    primariesUp = true;
    await expect(client.getTxPoolHashes()).resolves.toEqual(["from-primary"]);
    expect(calls[3]!.url).toBe(`${BACKEND_A}/get_transaction_pool_hashes`);
    expect(calls).toHaveLength(4);
  });

  it("throws an aggregate error when every primary AND the fallback fail", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, body: "boom" }));
    const client = moneroDaemonRpcClient({
      backends: [{ baseUrl: BACKEND_A }, { baseUrl: BACKEND_B }],
      fallbackBackend: { baseUrl: FALLBACK, headers: { "api-key": "SECRET" } },
      fetch
    });
    await expect(client.getTxPoolHashes()).rejects.toThrow(/all 3 backends failed/);
    // The aggregate message names each failed backend for diagnosability.
    await expect(client.getTxPoolHashes()).rejects.toThrow(
      new RegExp(`${BACKEND_A}.*${BACKEND_B}.*${FALLBACK}`)
    );
  });
});

describe("moneroDaemonRpcClient — getHardForkVersion", () => {
  it("returns the network hard-fork version", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRpcOk({ version: 16, enabled: true }));
    const client = moneroDaemonRpcClient({ backends: [{ baseUrl: BACKEND_A }], fetch });
    await expect(client.getHardForkVersion!()).resolves.toBe(16);
    expect(calls[0]!.body).toMatchObject({ method: "hard_fork_info" });
  });

  it("returns null (never throws) when every backend is unreachable — best-effort canary", async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const client = moneroDaemonRpcClient({ backends: [{ baseUrl: BACKEND_A }], fetch });
    await expect(client.getHardForkVersion!()).resolves.toBeNull();
  });
});
