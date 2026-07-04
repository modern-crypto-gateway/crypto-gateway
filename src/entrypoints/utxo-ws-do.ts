import type { DurableObjectState, ExecutionContext } from "@cloudflare/workers-types";
import { registerEventSubscribers } from "../app.js";
import type { AppDeps } from "../core/app-deps.js";
import {
  BITCOIN_CONFIG,
  LITECOIN_CONFIG
} from "../adapters/chains/utxo/utxo-config.js";
import {
  utxoMempoolWsWatcher,
  type UtxoMempoolWsWatcher
} from "../adapters/detection/utxo-mempool-ws.js";
import { depsFor, type WorkerEnv } from "./worker.js";

// Durable Object host for the UTXO WebSocket push watcher on Cloudflare
// Workers.
//
// A plain Worker invocation is request-scoped — it cannot hold a socket to
// mempool.space across requests, which is why the watcher was Node-only.
// A Durable Object CAN: one singleton DO ("global") owns the outbound
// WebSocket connections and stays resident while they're open. Detection
// events flow through the exact same code as everywhere else — the DO
// builds full AppDeps (Turso over HTTPS, KV cache, event bus + webhook
// subscribers) and runs the shared `utxoMempoolWsWatcher` unchanged; only
// the WebSocket transport differs (workerd's fetch-Upgrade handshake,
// adapted below).
//
// Liveness model (per Cloudflare docs as of 2026-06):
//   - An open OUTBOUND WebSocket pins a DO for at most 15 minutes; after
//     that the normal eviction clock applies — 70-140s with no incoming
//     events. WebSocket *hibernation* applies only to server-side sockets.
//     So the storage ALARM (re-armed every 30s) is the actual keepalive:
//     each firing is an incoming event that resets the eviction clock, it
//     survives evictions and deploys, and an alarm on an evicted object
//     re-runs the constructor — making it the self-healing reconnect path
//     too (deploys kill all outbound sockets; the next alarm rebuilds them
//     and the on-open REST reconcile backfills anything missed).
//   - The 1-minute platform cron pings /ensure as the outer dead-man's
//     switch (first start, and recovery if the alarm chain is ever lost).
//   - The fetch path pings /ensure (with a refresh) whenever a UTXO invoice
//     is created, so a brand-new address is tracked within ~1s — the HTTP
//     isolate's event bus is separate from the DO's, so the poke replaces
//     the in-process invoice.created subscription the Node runtime uses.
//   - With zero open UTXO invoices the watcher holds zero sockets and the
//     DO idles out of memory between watchdog wakes — cost scales with
//     actual invoice traffic.
//
// The 1-minute Esplora poll in the scheduled handler remains the
// correctness backstop exactly as on Node: the DO only accelerates.

const WATCHDOG_INTERVAL_MS = 30_000;

// Adapt workerd's client-WebSocket handshake to the standard WHATWG
// WebSocket surface the watcher codes against (constructor + readyState +
// addEventListener open/message/close/error + send/close). workerd's
// supported way to open an OUTBOUND socket is fetch() with an Upgrade
// header; the returned socket must be .accept()ed before use.
type CfWebSocket = {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, cb: (event: { data?: unknown }) => void): void;
};

// Workers allow at most SIX connections simultaneously waiting for response
// headers per invocation — outbound WebSocket upgrades count while the
// handshake is in flight. The watcher dials one socket per address chunk in
// a burst, so serialize the handshakes; an established socket stops
// counting, and ~400ms per handshake is irrelevant at our scale.
let handshakeQueue: Promise<void> = Promise.resolve();

class WorkerdWebSocketShim {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = WorkerdWebSocketShim.CONNECTING;
  private inner: CfWebSocket | null = null;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    void this.connect(url);
  }

  addEventListener(type: string, cb: (event: { data?: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.inner?.send(data);
  }

  close(): void {
    this.readyState = WorkerdWebSocketShim.CLOSED;
    try {
      this.inner?.close(1000, "client close");
    } catch {
      // already closed
    }
    this.emit("close", {});
  }

  private async connect(url: string): Promise<void> {
    // Wait our turn in the handshake queue (see note above), then take it.
    const previous = handshakeQueue;
    let release: () => void = () => {};
    handshakeQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // wss:// is not fetchable — the Upgrade handshake runs over https://.
      const httpUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
      let res: Response;
      try {
        res = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
      } finally {
        // Headers are in (or the fetch failed) — the connection no longer
        // counts against the six-in-handshake limit. Let the next one go.
        release();
      }
      const socket = (res as unknown as { webSocket: CfWebSocket | null }).webSocket;
      if (socket === null || socket === undefined) {
        throw new Error(`websocket upgrade refused (status ${res.status})`);
      }
      socket.accept();
      this.inner = socket;
      socket.addEventListener("message", (event) => this.emit("message", event));
      socket.addEventListener("close", () => {
        if (this.readyState !== WorkerdWebSocketShim.CLOSED) {
          this.readyState = WorkerdWebSocketShim.CLOSED;
          this.emit("close", {});
        }
      });
      socket.addEventListener("error", (event) => {
        this.emit("error", event);
      });
      if (this.readyState === WorkerdWebSocketShim.CLOSED) {
        // close() raced the handshake — honor it.
        socket.close(1000, "client close");
        return;
      }
      this.readyState = WorkerdWebSocketShim.OPEN;
      this.emit("open", {});
    } catch (event) {
      release(); // no-op if already released after the fetch
      this.readyState = WorkerdWebSocketShim.CLOSED;
      this.emit("error", { data: event });
      this.emit("close", {});
    }
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const cb of this.listeners.get(type) ?? []) {
      try {
        cb(event);
      } catch {
        // listener errors are the watcher's concern; never break the pump
      }
    }
  }
}

export class UtxoWsWatcherDO {
  private watcher: UtxoMempoolWsWatcher | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ensure") {
      await this.ensureStarted();
      // Every poke re-queries the watched set: the caller just created or
      // settled an invoice in another isolate, and the DO's own bus never
      // hears about it. The watcher's generation guard makes overlapping
      // refreshes safe.
      await this.watcher?.refresh();
      await this.armWatchdog();
      return json({ ok: true, status: this.watcher?.status() ?? [] });
    }
    if (url.pathname === "/status") {
      return json({ started: this.watcher !== null, status: this.watcher?.status() ?? [] });
    }
    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    await this.ensureStarted();
    await this.watcher?.refresh();
    // Re-arm unconditionally — the alarm is the eviction-proof heartbeat.
    await this.state.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
  }

  private async armWatchdog(): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.watcher !== null) return;
    // DurableObjectState.waitUntil is a legacy no-op (a DO stays resident
    // while I/O is pending), but the jobs adapter wants the ExecutionContext
    // shape — provide a compatible stand-in that at least surfaces errors.
    const ctxLike = {
      waitUntil: (promise: Promise<unknown>): void => {
        promise.catch((err) => {
          console.error("[utxo-ws-do] deferred job failed:", err);
        });
      },
      passThroughOnException: (): void => {}
    } as unknown as ExecutionContext;
    const deps: AppDeps = await depsFor(this.env, ctxLike);
    // The watcher's ingest publishes invoice/tx lifecycle events on the DO's
    // own bus — wire the subscribers or webhook deliveries for push-detected
    // payments silently vanish.
    registerEventSubscribers(deps);

    const wsUrlByChainId: Record<number, string> = {};
    const btcWsUrl = this.env["UTXO_WS_URL_BITCOIN"];
    if (typeof btcWsUrl === "string" && btcWsUrl.length > 0) {
      wsUrlByChainId[BITCOIN_CONFIG.chainId] = btcWsUrl;
    }
    const ltcWsUrl = this.env["UTXO_WS_URL_LITECOIN"];
    if (typeof ltcWsUrl === "string" && ltcWsUrl.length > 0) {
      wsUrlByChainId[LITECOIN_CONFIG.chainId] = ltcWsUrl;
    }
    this.watcher = utxoMempoolWsWatcher({
      deps,
      chains: [BITCOIN_CONFIG, LITECOIN_CONFIG],
      wsUrlByChainId,
      webSocketImpl: WorkerdWebSocketShim as unknown as typeof WebSocket
    });
    this.watcher.start();
    deps.logger.info("utxo-ws-do: watcher started in Durable Object");
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
