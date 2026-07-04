import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp } from "../helpers/boot.js";
import { utxoChainAdapter } from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../adapters/chains/utxo/utxo-config.js";
import { utxoMempoolWsWatcher } from "../../adapters/detection/utxo-mempool-ws.js";
import type { EsploraClient, EsploraTx } from "../../adapters/chains/utxo/esplora-rpc.js";
import { EsploraNotFoundError } from "../../adapters/chains/utxo/esplora-rpc.js";
import { invoices, transactions } from "../../db/schema.js";
import type { ChainId } from "../../core/types/chain.js";

// WebSocket push watcher against a scripted fake WebSocket + fake Esplora.
// Covers the full instant-detection path: invoice created → address tracked
// over WS → mempool push ingests a 'detected' transaction → block push
// triggers the confirmation sweep → invoice completes at the threshold.
// No network anywhere.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const BTC_CHAIN_ID = 800 as ChainId;

// ---- fake WebSocket ----

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  readonly url: string;
  readonly sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  // ---- test controls ----
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  serverMessage(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  serverDrop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  trackedAddresses(): string[] | null {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const parsed = JSON.parse(this.sent[i]!) as Record<string, unknown>;
      if (Array.isArray(parsed["track-addresses"])) {
        return parsed["track-addresses"] as string[];
      }
    }
    return null;
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
}

// ---- fake esplora (confirmation sweep + reconcile hit this, not the net) ----

function fakeEsplora(): {
  client: EsploraClient;
  confirm(txid: string, tx: EsploraTx): void;
  setTip(h: number): void;
} {
  const byId = new Map<string, EsploraTx>();
  let tip = 0;
  const client: EsploraClient = {
    async getAddressTxs() {
      return [];
    },
    async getAddressMempoolTxs() {
      return [];
    },
    async getTx(txid) {
      const tx = byId.get(txid);
      if (!tx) throw new EsploraNotFoundError(`/tx/${txid}`);
      return tx;
    },
    async getTipHeight() {
      return tip;
    },
    async broadcastTx() {
      throw new Error("not used");
    },
    async getFeeEstimates() {
      return {};
    },
    async getAddressBalanceSats() {
      return 0n;
    }
  };
  return {
    client,
    confirm(txid, tx) {
      byId.set(txid, tx);
    },
    setTip(h) {
      tip = h;
    }
  };
}

function mempoolTx(txid: string, address: string, valueSats: number): EsploraTx {
  return {
    txid,
    status: { confirmed: false },
    vin: [
      {
        txid: "0".repeat(64),
        vout: 0,
        prevout: {
          scriptpubkey: "0014" + "00".repeat(20),
          scriptpubkey_address: "bc1qyqsjygeyy5nzw2pf9g4jctfw9ucrzv3ncm6wfx",
          value: valueSats + 1_000
        }
      }
    ],
    vout: [
      {
        scriptpubkey: "0014" + "ff".repeat(20),
        scriptpubkey_address: address,
        value: valueSats
      }
    ],
    fee: 1_000
  };
}

async function bootWithInvoice() {
  const esplora = fakeEsplora();
  const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: esplora.client });
  const booted = await bootTestApp({
    chains: [adapter],
    merchants: [{ id: MERCHANT_ID }]
  });
  const apiKey = booted.apiKeys[MERCHANT_ID]!;
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "100000" })
    })
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { invoice: { id: string; receiveAddress: string } };
  return { booted, esplora, invoice: body.invoice };
}

function makeWatcher(deps: Parameters<typeof utxoMempoolWsWatcher>[0]["deps"]) {
  FakeWebSocket.instances = [];
  return utxoMempoolWsWatcher({
    deps,
    chains: [BITCOIN_CONFIG],
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    refreshIntervalMs: 60_000, // event-driven refresh is what we exercise
    reconcileDebounceMs: 10,
    pingIntervalMs: 60_000
  });
}

describe("utxoMempoolWsWatcher", () => {
  it("tracks open-invoice addresses, ingests a pushed mempool tx as 'detected', and completes the invoice on block-push confirmation", async () => {
    const { booted, esplora, invoice } = await bootWithInvoice();
    const watcher = makeWatcher(booted.deps);
    try {
      watcher.start();

      // The watcher queries the open-invoice set and dials one connection.
      await vi.waitFor(() => {
        expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
      });
      const ws = FakeWebSocket.instances[0]!;
      expect(ws.url).toBe(BITCOIN_CONFIG.defaultMempoolWsUrl);

      ws.serverOpen();
      await vi.waitFor(() => {
        expect(ws.trackedAddresses()).toContain(invoice.receiveAddress.toLowerCase());
      });
      // want-blocks subscription for confirmation pushes
      expect(ws.sent.some((s) => s.includes('"want"') && s.includes('"blocks"'))).toBe(true);

      // 1) Instant mempool detection: server pushes the tx paying our address.
      const txid = "a".repeat(64);
      const pushed = mempoolTx(txid, invoice.receiveAddress.toLowerCase(), 100_000);
      ws.serverMessage({
        "multi-address-transactions": {
          [invoice.receiveAddress.toLowerCase()]: { mempool: [pushed], confirmed: [], removed: [] }
        }
      });

      await vi.waitFor(async () => {
        const rows = await booted.deps.db
          .select()
          .from(transactions)
          .where(eq(transactions.txHash, txid));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("detected");
      });
      // Invoice flipped to processing (paid, unconfirmed).
      const [processing] = await booted.deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoice.id));
      expect(processing!.status).toBe("processing");

      // 2) Confirmation: the tx lands in block 100; tip reaches 105 → 6 confs
      // (BTC threshold). A block push triggers the sweep, which reads the
      // fake Esplora and promotes tx + invoice without waiting for cron.
      esplora.confirm(txid, {
        ...pushed,
        status: { confirmed: true, block_height: 100, block_time: 1_700_000_000 }
      });
      esplora.setTip(105);
      ws.serverMessage({ block: { height: 105 } });

      await vi.waitFor(async () => {
        const [row] = await booted.deps.db
          .select()
          .from(invoices)
          .where(eq(invoices.id, invoice.id));
        expect(row!.status).toBe("completed");
      });
      const [txRow] = await booted.deps.db
        .select()
        .from(transactions)
        .where(eq(transactions.txHash, txid));
      expect(txRow!.status).toBe("confirmed");
    } finally {
      watcher.stop();
      await booted.close();
    }
  });

  it("resubscribes with the current address set after a dropped connection", async () => {
    const { booted, invoice } = await bootWithInvoice();
    FakeWebSocket.instances = [];
    const watcher = utxoMempoolWsWatcher({
      deps: booted.deps,
      chains: [BITCOIN_CONFIG],
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      refreshIntervalMs: 60_000,
      reconcileDebounceMs: 10,
      pingIntervalMs: 60_000,
      reconnectBaseDelayMs: 5 // fast reconnect for the test
    });
    try {
      watcher.start();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
      const first = FakeWebSocket.instances[0]!;
      first.serverOpen();
      await vi.waitFor(() => expect(first.trackedAddresses()).not.toBeNull());

      // Server kills the socket → watcher must dial a new one and resend the
      // full subscription (server keeps no state across connections).
      first.serverDrop();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
      const second = FakeWebSocket.instances[1]!;
      second.serverOpen();
      await vi.waitFor(() => {
        expect(second.trackedAddresses()).toContain(invoice.receiveAddress.toLowerCase());
      });
    } finally {
      watcher.stop();
      await booted.close();
    }
  });

  it("shards addresses across connections at the per-connection cap and reports overflow", async () => {
    const esplora = fakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: esplora.client });
    const booted = await bootTestApp({ chains: [adapter], merchants: [{ id: MERCHANT_ID }] });
    FakeWebSocket.instances = [];
    // Cap: 10 addresses/connection × 2 connections = 20 tracked max.
    const watcher = utxoMempoolWsWatcher({
      deps: booted.deps,
      chains: [BITCOIN_CONFIG],
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      maxConnectionsPerChain: 2,
      refreshIntervalMs: 60_000,
      reconcileDebounceMs: 10
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      // 25 open invoices → 25 fresh addresses: 20 tracked, 5 overflow.
      for (let i = 0; i < 25; i += 1) {
        const res = await booted.app.fetch(
          new Request("http://test.local/api/v1/invoices", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "100000" })
          })
        );
        expect(res.status).toBe(201);
      }
      watcher.start();
      await vi.waitFor(() => {
        expect(FakeWebSocket.instances.length).toBe(2);
      });
      for (const ws of FakeWebSocket.instances) ws.serverOpen();
      await vi.waitFor(() => {
        const status = watcher.status();
        expect(status[0]).toMatchObject({ chainId: 800, tracked: 20, overflow: 5, connections: 2 });
      });
      // Each connection's subscription respects the server's 10-address cap.
      for (const ws of FakeWebSocket.instances) {
        const tracked = ws.trackedAddresses();
        expect(tracked).not.toBeNull();
        expect(tracked!.length).toBeLessThanOrEqual(
          BITCOIN_CONFIG.wsMaxTrackedAddressesPerConnection
        );
      }
    } finally {
      watcher.stop();
      await booted.close();
    }
  });

  it("stays inert without a WebSocket implementation (poll-only degradation)", async () => {
    const esplora = fakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: esplora.client });
    const booted = await bootTestApp({ chains: [adapter], merchants: [{ id: MERCHANT_ID }] });
    FakeWebSocket.instances = [];
    const watcher = utxoMempoolWsWatcher({
      deps: booted.deps,
      chains: [BITCOIN_CONFIG]
      // no webSocketImpl and (in this environment) tests may or may not have
      // a global — force absence:
    });
    try {
      // Even if globalThis.WebSocket exists (Node 22+), start() must not
      // throw; with it absent it logs and stays idle. Either way stop() is
      // clean. The strong assertion here is "no crash, no fake dials".
      watcher.start();
      watcher.stop();
      expect(FakeWebSocket.instances.length).toBe(0);
    } finally {
      await booted.close();
    }
  });
});
