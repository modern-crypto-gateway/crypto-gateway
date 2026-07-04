import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { AppDeps } from "../../core/app-deps.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import { confirmTransactions, ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import {
  LATE_PAYMENT_WATCH_MS,
  PROCESSING_EXPIRY_GRACE_MS
} from "../../core/domain/payment-config.js";
import { invoices, invoiceReceiveAddresses } from "../../db/schema.js";
import type { UtxoChainConfig } from "../chains/utxo/utxo-config.js";
import { projectTxOutputs } from "../chains/utxo/utxo-chain.adapter.js";
import type { EsploraTx } from "../chains/utxo/esplora-rpc.js";

// UTXO push detection over the mempool.space WebSocket API (served by
// mempool.space for BTC and litecoinspace.org for LTC — same codebase, same
// wire protocol, both free with no API key).
//
// Why this exists: the Esplora poll runs on the 1-minute scheduled-jobs tick,
// so worst-case mempool detection is a full minute after broadcast. The WS
// `track-addresses` subscription pushes the SAME Esplora-format tx objects
// the instant a watched address sees a mempool tx or a block confirms one —
// we project them through the identical `projectTxOutputs` path and ingest.
// The poll stays on as the reconciliation layer (the socket has NO backfill:
// anything broadcast during a reconnect gap only surfaces via REST), so a
// watcher outage degrades latency, never correctness.
//
// Server-side facts this file is built around (probed live 2026-07):
//   - Subscribe: {"track-addresses": [...]} — each message REPLACES the
//     connection's whole tracked set; empty array unsubscribes.
//   - Per-connection address caps: mempool.space = 10, litecoinspace = 100
//     (carried in UtxoChainConfig.wsMaxTrackedAddressesPerConnection). More
//     addresses ⇒ shard across connections, bounded by maxConnectionsPerChain;
//     overflow addresses stay poll-only (logged).
//   - Push keys: "multi-address-transactions" {addr: {mempool[], confirmed[],
//     removed[]}}, plus "address-transactions"/"block-transactions" for the
//     singular subscription form. Txs are full Esplora format.
//   - {"action":"want","data":["blocks"]} subscribes "block" pushes — our
//     trigger to run the confirmation sweep seconds after each new block
//     instead of waiting for the next cron tick.
//   - Idle sockets are killed ~120s after the last server message (nginx
//     proxy_read_timeout) — send {"action":"ping"} every ~30s.
//   - Runtime: requires globalThis.WebSocket (Node >= 22, Bun, Deno). On
//     older Nodes the watcher logs a warning and stays inert (poll covers).

const PING_INTERVAL_MS = 30_000;
// Force-reconnect when nothing (not even a pong) arrived for two ping
// windows — the socket is dead even if the runtime hasn't noticed.
const STALE_CONNECTION_MS = 75_000;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
// Debounce for the REST reconcile after (re)subscribes and for the
// block-triggered confirmation sweep: WS events arrive in bursts (one per
// connection per block) — coalesce before hitting the DB/REST.
const RECONCILE_DEBOUNCE_MS = 1_500;

export interface UtxoMempoolWsWatcherConfig {
  readonly deps: AppDeps;
  // Which UTXO chains to watch. Entrypoints pass the configs of the chains
  // they actually wired (mainnet BTC + LTC today).
  readonly chains: readonly UtxoChainConfig[];
  // Per-chainId WS URL override (env: UTXO_WS_URL_<SLUG>); defaults to the
  // chain config's public endpoint.
  readonly wsUrlByChainId?: Readonly<Record<number, string>>;
  // Cap on concurrent sockets per chain. BTC's 10-address connections × 6 =
  // 60 watchable addresses; beyond that the poll covers the tail. Public-
  // infrastructure etiquette: don't open dozens of sockets per process.
  readonly maxConnectionsPerChain?: number;
  // How often to re-query the open-invoice address set as a safety net
  // (event-driven refreshes handle the common path instantly).
  readonly refreshIntervalMs?: number;
  // Test seams.
  readonly webSocketImpl?: typeof WebSocket;
  readonly pingIntervalMs?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconcileDebounceMs?: number;
}

export interface UtxoMempoolWsWatcher {
  start(): void;
  stop(): void;
  // Re-query the open-invoice address set now. The in-process event bus
  // already triggers this for same-isolate invoice lifecycle events; hosts
  // where invoice creation happens in a DIFFERENT isolate (the Workers
  // Durable Object host — HTTP requests run in per-request isolates with
  // their own event bus) call this when they poke the watcher.
  refresh(): Promise<void>;
  // Ops/test introspection: current tracked-address + connection counts.
  status(): ReadonlyArray<{
    chainId: number;
    tracked: number;
    overflow: number;
    connections: number;
    openConnections: number;
  }>;
}

// Message shapes we consume (subset — unknown keys ignored).
interface MultiAddressTransactions {
  readonly [address: string]: {
    readonly mempool?: readonly EsploraTx[];
    readonly confirmed?: readonly EsploraTx[];
    readonly removed?: readonly EsploraTx[];
  };
}

interface WsMessage {
  readonly "multi-address-transactions"?: MultiAddressTransactions;
  readonly "address-transactions"?: readonly EsploraTx[];
  readonly "block-transactions"?: readonly EsploraTx[];
  readonly block?: { readonly height?: number };
  readonly blocks?: ReadonlyArray<{ readonly height?: number }>;
  readonly pong?: unknown;
  readonly "track-addresses-error"?: string;
}

interface ChainConnection {
  ws: WebSocket | null;
  addresses: readonly string[];
  lastMessageAt: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  closedByUs: boolean;
}

interface ChainState {
  readonly chain: UtxoChainConfig;
  readonly wsUrl: string;
  // Current watched set (sorted, deduped, chain-HRP-filtered).
  watched: readonly string[];
  overflow: number;
  connections: ChainConnection[];
  // Best tip height seen over the socket — used only for projecting
  // confirmations on pushed txs; authoritative counting stays with the
  // confirmation sweep (REST tip).
  tipHeight: number;
}

export function utxoMempoolWsWatcher(config: UtxoMempoolWsWatcherConfig): UtxoMempoolWsWatcher {
  const { deps } = config;
  const logger = deps.logger;
  const WebSocketImpl =
    config.webSocketImpl ??
    (typeof globalThis.WebSocket !== "undefined" ? globalThis.WebSocket : undefined);
  const maxConnectionsPerChain = config.maxConnectionsPerChain ?? 6;
  const refreshIntervalMs = config.refreshIntervalMs ?? 60_000;
  const pingIntervalMs = config.pingIntervalMs ?? PING_INTERVAL_MS;
  const reconnectBaseDelayMs = config.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
  const reconcileDebounceMs = config.reconcileDebounceMs ?? RECONCILE_DEBOUNCE_MS;

  const states = new Map<number, ChainState>();
  for (const chain of config.chains) {
    states.set(chain.chainId, {
      chain,
      wsUrl: config.wsUrlByChainId?.[chain.chainId] ?? chain.defaultMempoolWsUrl,
      watched: [],
      overflow: 0,
      connections: [],
      tipHeight: 0
    });
  }

  let started = false;
  let stopped = false;
  // Monotonic generation for watched-set refreshes: the interval timer and
  // event-driven triggers overlap freely, and DB round-trips can complete
  // out of order — only the newest query's result may be applied, or a
  // stale set would overwrite a fresher one.
  let refreshGeneration = 0;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmRunning = false;
  let confirmQueued = false;
  const eventUnsubscribes: Array<() => void> = [];

  // ---- watched-set maintenance ----

  // Same open-invoice predicate as poll-payments.ts (incl. the processing
  // grace window) so push and poll watch the same addresses.
  async function queryWatchedAddresses(): Promise<Map<number, string[]>> {
    const now = deps.clock.now().getTime();
    const rows = await deps.db
      .select({
        chainId: invoiceReceiveAddresses.chainId,
        address: invoiceReceiveAddresses.address
      })
      .from(invoices)
      .innerJoin(invoiceReceiveAddresses, eq(invoiceReceiveAddresses.invoiceId, invoices.id))
      .where(
        and(
          eq(invoiceReceiveAddresses.family, "utxo"),
          or(
            and(inArray(invoices.status, ["pending", "completed"]), gt(invoices.expiresAt, now)),
            and(
              eq(invoices.status, "processing"),
              gt(invoices.expiresAt, now - PROCESSING_EXPIRY_GRACE_MS)
            ),
            // Post-expiry watch window — late payments orphan-park for the
            // admin queue instead of vanishing (mirrors poll-payments).
            and(
              eq(invoices.status, "expired"),
              gt(invoices.expiresAt, now - LATE_PAYMENT_WATCH_MS)
            )
          )
        )
      );
    const byChain = new Map<number, string[]>();
    for (const row of rows) {
      const list = byChain.get(row.chainId) ?? [];
      list.push(row.address.toLowerCase());
      byChain.set(row.chainId, list);
    }
    return byChain;
  }

  async function refreshWatchedSet(): Promise<void> {
    if (stopped) return;
    const generation = ++refreshGeneration;
    let byChain: Map<number, string[]>;
    try {
      byChain = await queryWatchedAddresses();
    } catch (err) {
      logger.warn("utxo-ws: watched-address query failed (retrying next refresh)", {
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    // A newer refresh started while our query was in flight — its result
    // supersedes ours; applying ours would roll the watched set backwards.
    if (generation !== refreshGeneration || stopped) return;
    for (const state of states.values()) {
      const hrpPrefix = `${state.chain.bech32Hrp}1`;
      const all = Array.from(
        new Set((byChain.get(state.chain.chainId) ?? []).filter((a) => a.startsWith(hrpPrefix)))
      ).sort();
      const cap = state.chain.wsMaxTrackedAddressesPerConnection * maxConnectionsPerChain;
      const watched = all.slice(0, cap);
      const overflow = all.length - watched.length;
      if (overflow > 0 && state.overflow !== overflow) {
        // Never silently degrade: operators should know some invoices are on
        // the 1-minute poll only.
        logger.warn("utxo-ws: tracked-address capacity exceeded — overflow covered by poll only", {
          chainId: state.chain.chainId,
          capacity: cap,
          overflow
        });
      }
      state.overflow = overflow;
      const changed =
        watched.length !== state.watched.length ||
        watched.some((a, i) => a !== state.watched[i]);
      state.watched = watched;
      if (changed) syncConnections(state);
    }
  }

  // ---- connection lifecycle ----

  function chunkAddresses(state: ChainState): string[][] {
    const size = state.chain.wsMaxTrackedAddressesPerConnection;
    const chunks: string[][] = [];
    for (let i = 0; i < state.watched.length; i += size) {
      chunks.push(state.watched.slice(i, i + size));
    }
    return chunks;
  }

  // Reconcile the connection pool with the current chunking. Existing
  // sockets get the new set via a fresh `track-addresses` (server replaces
  // the whole subscription); surplus sockets close; missing ones dial.
  function syncConnections(state: ChainState): void {
    if (stopped) return;
    const chunks = chunkAddresses(state);
    // Close surplus connections.
    while (state.connections.length > chunks.length) {
      const conn = state.connections.pop()!;
      teardownConnection(conn);
    }
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!;
      const existing = state.connections[i];
      if (existing === undefined) {
        const conn: ChainConnection = {
          ws: null,
          addresses: chunk,
          lastMessageAt: 0,
          reconnectAttempts: 0,
          reconnectTimer: null,
          pingTimer: null,
          closedByUs: false
        };
        state.connections.push(conn);
        dial(state, conn);
        continue;
      }
      const same =
        existing.addresses.length === chunk.length &&
        existing.addresses.every((a, j) => a === chunk[j]);
      existing.addresses = chunk;
      if (!same && existing.ws !== null && existing.ws.readyState === WebSocketImpl!.OPEN) {
        sendSubscription(state, existing);
        // Membership changed → REST-reconcile: a tx may have landed on the
        // newly-added address before the subscription took effect.
        scheduleReconcile();
      }
    }
  }

  function dial(state: ChainState, conn: ChainConnection): void {
    if (stopped || WebSocketImpl === undefined) return;
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(state.wsUrl);
    } catch (err) {
      logger.warn("utxo-ws: connect failed", {
        chainId: state.chain.chainId,
        url: state.wsUrl,
        error: err instanceof Error ? err.message : String(err)
      });
      scheduleReconnect(state, conn);
      return;
    }
    conn.ws = ws;
    conn.closedByUs = false;

    ws.addEventListener("open", () => {
      conn.reconnectAttempts = 0;
      conn.lastMessageAt = Date.now();
      sendSubscription(state, conn);
      // Blocks feed drives the fast confirmation sweep.
      trySend(ws, { action: "want", data: ["blocks"] });
      startPing(state, conn);
      // No backfill on subscribe: reconcile via REST so anything broadcast
      // before this subscription (or during a reconnect gap) is picked up.
      scheduleReconcile();
      logger.info("utxo-ws: connected", {
        chainId: state.chain.chainId,
        tracked: conn.addresses.length
      });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      conn.lastMessageAt = Date.now();
      // The frame comes from an untrusted third-party server; handleMessage
      // validates shapes, but any escaped throw here would become an
      // unhandled promise rejection and take down the whole gateway process
      // — catch unconditionally.
      handleMessage(state, conn, typeof event.data === "string" ? event.data : "").catch(
        (err) => {
          logger.error("utxo-ws: message handler failed", {
            chainId: state.chain.chainId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      );
    });

    const onGone = (reason: string): void => {
      if (conn.ws !== ws) return; // superseded by a newer dial
      stopPing(conn);
      conn.ws = null;
      if (stopped || conn.closedByUs) return;
      logger.warn("utxo-ws: connection lost — reconnecting", {
        chainId: state.chain.chainId,
        reason
      });
      scheduleReconnect(state, conn);
    };
    ws.addEventListener("close", () => onGone("close"));
    ws.addEventListener("error", () => onGone("error"));
  }

  function scheduleReconnect(state: ChainState, conn: ChainConnection): void {
    if (stopped || conn.reconnectTimer !== null) return;
    // Exponential backoff with jitter, matching the official client's
    // 2s + random pattern; capped so an extended outage retries once a
    // minute instead of hammering.
    const backoff = Math.min(
      reconnectBaseDelayMs * 2 ** Math.min(conn.reconnectAttempts, 5),
      RECONNECT_MAX_DELAY_MS
    );
    const delay = backoff + Math.floor(Math.random() * reconnectBaseDelayMs);
    conn.reconnectAttempts += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      dial(state, conn);
    }, delay);
  }

  function sendSubscription(state: ChainState, conn: ChainConnection): void {
    if (conn.ws === null) return;
    trySend(conn.ws, { "track-addresses": conn.addresses });
  }

  function startPing(state: ChainState, conn: ChainConnection): void {
    stopPing(conn);
    conn.pingTimer = setInterval(() => {
      const ws = conn.ws;
      if (ws === null || ws.readyState !== WebSocketImpl!.OPEN) return;
      if (Date.now() - conn.lastMessageAt > STALE_CONNECTION_MS) {
        // Two silent ping windows — the TCP session is a zombie. Close and
        // let the reconnect path (with REST reconcile) take over.
        logger.warn("utxo-ws: stale connection (no server traffic) — recycling", {
          chainId: state.chain.chainId
        });
        try {
          ws.close();
        } catch {
          // ignore — onGone handles state
        }
        return;
      }
      trySend(ws, { action: "ping" });
    }, pingIntervalMs);
  }

  function stopPing(conn: ChainConnection): void {
    if (conn.pingTimer !== null) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
  }

  function teardownConnection(conn: ChainConnection): void {
    conn.closedByUs = true;
    stopPing(conn);
    if (conn.reconnectTimer !== null) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.ws !== null) {
      try {
        conn.ws.close();
      } catch {
        // already closing/closed
      }
      conn.ws = null;
    }
  }

  function trySend(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      logger.warn("utxo-ws: send failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // ---- inbound message handling ----

  // Minimal shape check before projection: frames come from an untrusted
  // public server, and a tx entry missing vin/vout would TypeError deep in
  // projectTxOutputs. Anything malformed is skipped, never thrown.
  function isTxLike(tx: unknown): tx is EsploraTx {
    return (
      typeof tx === "object" &&
      tx !== null &&
      typeof (tx as EsploraTx).txid === "string" &&
      Array.isArray((tx as EsploraTx).vin) &&
      Array.isArray((tx as EsploraTx).vout) &&
      typeof (tx as EsploraTx).status === "object" &&
      (tx as EsploraTx).status !== null
    );
  }

  async function handleMessage(state: ChainState, conn: ChainConnection, raw: string): Promise<void> {
    if (raw.length === 0) return;
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      return; // non-JSON frame — ignore
    }
    if (typeof msg !== "object" || msg === null) return;

    if (typeof msg["track-addresses-error"] === "string") {
      // Server rejected the subscription — it NULLS the connection's whole
      // tracked set, so this socket is now watching nothing. Logging alone
      // would leave it a silent zombie (refresh only re-sends on membership
      // change); recycle the connection instead so the reconnect path
      // re-dials, resubscribes, and REST-reconciles.
      logger.error("utxo-ws: subscription rejected by server — recycling connection", {
        chainId: state.chain.chainId,
        error: msg["track-addresses-error"]
      });
      try {
        conn.ws?.close();
      } catch {
        // onGone handles state either way
      }
      return;
    }

    // Track tip from block pushes; trigger the fast confirmation sweep.
    const blocks = Array.isArray(msg.blocks)
      ? msg.blocks
      : msg.block !== undefined
        ? [msg.block]
        : [];
    let sawNewBlock = false;
    for (const b of blocks) {
      if (typeof b?.height === "number" && b.height > state.tipHeight) {
        state.tipHeight = b.height;
        sawNewBlock = true;
      }
    }
    if (sawNewBlock) scheduleConfirmSweep();

    const candidates: unknown[] = [];
    if (Array.isArray(msg["address-transactions"])) candidates.push(...msg["address-transactions"]);
    if (Array.isArray(msg["block-transactions"])) candidates.push(...msg["block-transactions"]);
    if (typeof msg["multi-address-transactions"] === "object" && msg["multi-address-transactions"] !== null) {
      for (const perAddress of Object.values(msg["multi-address-transactions"])) {
        if (typeof perAddress !== "object" || perAddress === null) continue;
        if (Array.isArray(perAddress.mempool)) candidates.push(...perAddress.mempool);
        if (Array.isArray(perAddress.confirmed)) candidates.push(...perAddress.confirmed);
        // `removed` = RBF replacement / mempool eviction. We deliberately do
        // NOT ingest removals: unconfirmed credits only ever surface as
        // 'detected' (never complete an invoice), and the confirmation sweep
        // + reorg recheck are the authoritative demotion paths.
      }
    }
    const txs = candidates.filter(isTxLike);
    if (txs.length === 0) return;

    const ourAddresses = new Set(state.watched);
    const transfers: DetectedTransfer[] = [];
    const seenAt = deps.clock.now();
    for (const tx of txs) {
      // A pushed tx can pay several of our watched addresses — project once
      // per watched recipient (projectTxOutputs scopes to one).
      const recipients = new Set<string>();
      for (const vout of tx.vout) {
        const addr = vout?.scriptpubkey_address?.toLowerCase();
        if (addr !== undefined && ourAddresses.has(addr)) recipients.add(addr);
      }
      for (const recipient of recipients) {
        transfers.push(
          ...projectTxOutputs(
            tx,
            recipient,
            ourAddresses,
            state.chain.chainId,
            state.chain,
            state.tipHeight,
            seenAt
          )
        );
      }
    }
    if (transfers.length === 0) return;

    logger.info("utxo-ws: push detected transfers", {
      chainId: state.chain.chainId,
      count: transfers.length
    });
    for (const transfer of transfers) {
      try {
        // Idempotent on (chainId, txHash, vout) — poll/push double-delivery
        // collapses to a duplicate no-op inside ingest.
        await ingestDetectedTransfer(deps, transfer);
      } catch (err) {
        logger.error("utxo-ws: ingest failed for pushed transfer", {
          chainId: transfer.chainId,
          txHash: transfer.txHash,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  // ---- debounced follow-ups ----

  // REST reconcile: reuse the poll path (it scans every open-invoice address
  // via Esplora and ingests). Debounced — several connections (re)subscribe
  // in a burst on boot/reconnect.
  function scheduleReconcile(): void {
    if (stopped || reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      void (async () => {
        try {
          const { pollPayments } = await import("../../core/domain/poll-payments.js");
          await pollPayments(deps);
        } catch (err) {
          logger.warn("utxo-ws: post-subscribe reconcile failed (cron poll will cover)", {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      })();
    }, reconcileDebounceMs);
  }

  // Block-triggered confirmation sweep: promotes 'detected' rows the moment
  // the threshold block lands instead of waiting for the next cron tick.
  // Single-flight with a queued re-run so bursts (BTC + LTC blocks together)
  // collapse but never skip a block.
  function scheduleConfirmSweep(): void {
    if (stopped || confirmTimer !== null) return;
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      void runConfirmSweep();
    }, reconcileDebounceMs);
  }

  async function runConfirmSweep(): Promise<void> {
    if (confirmRunning) {
      confirmQueued = true;
      return;
    }
    confirmRunning = true;
    try {
      await confirmTransactions(deps);
    } catch (err) {
      logger.warn("utxo-ws: block-triggered confirmation sweep failed (cron will cover)", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      confirmRunning = false;
      if (confirmQueued) {
        confirmQueued = false;
        void runConfirmSweep();
      }
    }
  }

  // ---- public surface ----

  return {
    start(): void {
      if (started) return;
      started = true;
      if (WebSocketImpl === undefined) {
        logger.warn(
          "utxo-ws: globalThis.WebSocket unavailable (Node < 22?) — instant UTXO detection disabled, poll-only"
        );
        return;
      }
      if (states.size === 0) return;

      // Event-driven refresh: a new UTXO invoice must be tracked the moment
      // it's created (the customer is about to pay it), and settled/expired
      // invoices should free their WS slot promptly.
      const onLifecycle = (): void => {
        void refreshWatchedSet();
      };
      for (const type of [
        "invoice.created",
        "invoice.completed",
        "invoice.expired",
        "invoice.canceled"
      ] as const) {
        eventUnsubscribes.push(deps.events.subscribe(type, async () => onLifecycle()));
      }

      refreshTimer = setInterval(() => void refreshWatchedSet(), refreshIntervalMs);
      void refreshWatchedSet();
      logger.info("utxo-ws: watcher started", {
        chains: Array.from(states.values()).map((s) => ({
          chainId: s.chain.chainId,
          wsUrl: s.wsUrl,
          maxTracked: s.chain.wsMaxTrackedAddressesPerConnection * maxConnectionsPerChain
        }))
      });
    },

    async refresh(): Promise<void> {
      await refreshWatchedSet();
    },

    stop(): void {
      stopped = true;
      if (refreshTimer !== null) clearInterval(refreshTimer);
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      if (confirmTimer !== null) clearTimeout(confirmTimer);
      for (const unsub of eventUnsubscribes) unsub();
      for (const state of states.values()) {
        for (const conn of state.connections) teardownConnection(conn);
        state.connections = [];
      }
    },

    status() {
      return Array.from(states.values()).map((state) => ({
        chainId: state.chain.chainId,
        tracked: state.watched.length,
        overflow: state.overflow,
        connections: state.connections.length,
        openConnections: state.connections.filter(
          (c) => c.ws !== null && c.ws.readyState === WebSocketImpl?.OPEN
        ).length
      }));
    }
  };
}
