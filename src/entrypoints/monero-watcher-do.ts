import type { DurableObjectState, ExecutionContext } from "@cloudflare/workers-types";
import { registerEventSubscribers } from "../app.js";
import type { AppDeps } from "../core/app-deps.js";
import type { ChainId } from "../core/types/chain.js";
import { isMoneroChainAdapter } from "../adapters/chains/monero/monero-chain.adapter.js";
import {
  moneroTxpoolWatcher,
  type MoneroTxpoolWatcher,
  type MoneroWatcherStorage
} from "../adapters/detection/monero-txpool.js";
import { depsFor, type WorkerEnv } from "./worker.js";

// Durable Object host for the Monero txpool watcher on Cloudflare Workers.
//
// Cron Triggers bottom out at 1 minute, so a plain Worker can never poll the
// Monero txpool at the ~10 s cadence instant detection needs. A Durable
// Object CAN: its alarm() re-schedules itself every ~10 s while live XMR
// invoices exist, and each firing runs one watcher tick (txpool hash diff +
// view-key scan of new txs, plus a block-walk pass every ~60 s). Detection
// events flow through the exact same code as everywhere else — the DO
// builds full AppDeps and the shared watcher ingests via
// ingestDetectedTransfer, same as the UTXO WS Durable Object.
//
// Liveness model (identical to UtxoWsWatcherDO):
//   - The storage ALARM is the keepalive AND the scheduler: it survives
//     evictions and deploys, and an alarm firing on an evicted object
//     re-runs the constructor — self-healing by construction.
//   - The 1-minute platform cron pings /ensure as the outer dead-man's
//     switch (first start, and recovery if the alarm chain is ever lost).
//   - The fetch path pings /ensure (with a refresh) whenever a Monero
//     invoice is created, so a brand-new subaddress is watched within ~1 s.
//   - With zero live XMR invoices the alarm degrades to a slow idle cadence
//     that only refreshes the watched set and fast-forwards the block
//     cursor — cost scales with actual invoice traffic.
//
// Alarm-cadence economics (Workers Paid): even 24/7 at 10 s ≈ 263k alarm
// firings + 263k setAlarm row-writes per month — both inside the included
// DO quotas (1M requests, 50M rows), and duration at 128 MB residency stays
// under the included 400k GB-s. Marginal cost ≈ $0.
//
// Storage: seen-set + block cursor live in the DO's OWN SQLite (strongly
// consistent, no TTL, transactional) — NOT Workers KV, whose eventual
// consistency and 1-write/sec/key limit are wrong for a scan cursor.

const ACTIVE_ALARM_MS = 10_000;
const IDLE_ALARM_MS = 60_000;

export class MoneroWatcherDO {
  private watcher: MoneroTxpoolWatcher | null = null;
  // True while a tick is executing — alarm() and /ensure can interleave;
  // ticks must not.
  private ticking = false;
  private lastTickActive = true;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ensure") {
      if (this.txpoolDisabled()) {
        // Kill switch flipped since this DO last started — stop rescheduling
        // and let the cron block-scan fallback own detection (see alarm()).
        await this.state.storage.deleteAlarm();
        return json({ ok: false, reason: "MONERO_TXPOOL disabled" });
      }
      const started = await this.ensureStarted();
      if (!started) {
        // Monero not configured on this deployment — nothing to watch.
        return json({ ok: false, reason: "monero adapter not configured" });
      }
      // Every poke re-queries the watched set: the caller just created or
      // settled an invoice in another isolate, and the DO's own bus never
      // hears about it. Then run a tick immediately — a customer is likely
      // staring at the checkout page right now.
      try {
        await this.watcher?.refreshWatchedSet();
      } catch (err) {
        console.error("[monero-watcher-do] refresh on ensure failed:", err);
      }
      await this.runTickAndRearm();
      return json({ ok: true, status: this.watcher?.status() ?? null });
    }
    if (url.pathname === "/status") {
      return json({
        started: this.watcher !== null,
        status: this.watcher?.status() ?? null,
        alarmAt: await this.state.storage.getAlarm()
      });
    }
    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    // The DO is a persistent singleton whose alarm reschedules itself
    // forever — it must honor the SAME MONERO_TXPOOL kill switch the
    // entrypoints use to gate detection ownership. Without this, flipping
    // MONERO_TXPOOL=off (without removing the DO binding, which needs a
    // migration) leaves this alarm chain alive AND registers the cron
    // block-scan fallback → two writers scanning the chain and the same
    // cursor key. Stop the chain cleanly instead.
    if (this.txpoolDisabled()) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const started = await this.ensureStarted();
    if (!started) return; // not configured — let the alarm chain die
    await this.runTickAndRearm();
  }

  // off/0/false — same spellings the entrypoints' moneroTxpoolEnabled uses.
  private txpoolDisabled(): boolean {
    const knob = String(this.env["MONERO_TXPOOL"] ?? "").toLowerCase();
    return knob === "off" || knob === "0" || knob === "false";
  }

  // Re-arm FIRST (so a tick crash can't kill the alarm chain), then tick.
  // At-least-once alarm semantics + idempotent ticks (dedup at ingest,
  // monotonic cursor) make the ordering safe.
  private async runTickAndRearm(): Promise<void> {
    const interval = this.lastTickActive ? this.activeAlarmMs() : IDLE_ALARM_MS;
    await this.state.storage.setAlarm(Date.now() + interval);
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.watcher!.tick();
      if (result.active !== this.lastTickActive) {
        this.lastTickActive = result.active;
        // Cadence changed (idle↔active) — bring the pending alarm in line
        // immediately rather than waiting out the old interval.
        const next = result.active ? this.activeAlarmMs() : IDLE_ALARM_MS;
        await this.state.storage.setAlarm(Date.now() + next);
      }
    } catch (err) {
      console.error("[monero-watcher-do] tick failed (alarm chain continues):", err);
    } finally {
      this.ticking = false;
    }
  }

  private activeAlarmMs(): number {
    const raw = this.env["MONERO_TXPOOL_POLL_MS"];
    const parsed = typeof raw === "string" ? Number(raw) : NaN;
    // Floor 5s: public-node etiquette — sub-5s polling buys almost no
    // latency (pool relay itself takes a couple of seconds) and doubles
    // the request load on community infrastructure.
    return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : ACTIVE_ALARM_MS;
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.watcher !== null) return true;
    const ctxLike = {
      waitUntil: (promise: Promise<unknown>): void => {
        promise.catch((err) => {
          console.error("[monero-watcher-do] deferred job failed:", err);
        });
      },
      passThroughOnException: (): void => {}
    } as unknown as ExecutionContext;
    const deps: AppDeps = await depsFor(this.env, ctxLike);
    const adapter = deps.chains.find(isMoneroChainAdapter);
    if (adapter === undefined) return false;
    // The watcher's ingest publishes invoice/tx lifecycle events on the DO's
    // own bus — wire the subscribers or webhook deliveries for pool-detected
    // payments silently vanish.
    registerEventSubscribers(deps);

    const chainId = adapter.supportedChainIds[0] as ChainId;
    const blockScanRaw = this.env["MONERO_BLOCK_SCAN_MS"];
    const blockScanParsed = typeof blockScanRaw === "string" ? Number(blockScanRaw) : NaN;
    this.watcher = moneroTxpoolWatcher({
      deps,
      adapter,
      chainId,
      storage: doSqliteWatcherStorage(this.state, deps.cache, chainId),
      ...(Number.isFinite(blockScanParsed) && blockScanParsed >= 15_000
        ? { blockPassIntervalMs: blockScanParsed }
        : {})
    });
    deps.logger.info("monero-watcher-do: txpool watcher started in Durable Object", { chainId });
    return true;
  }
}

// Seen-set in a DO SQLite table (thousands of rows, pruned by timestamp);
// block cursor in the DO's key-value storage (one hot key, strongly
// consistent). Both survive eviction and deploys.
//
// The cursor is additionally MIRRORED to the shared cache under the same
// key the cron block-scan path uses (`monero:last_scanned_height:<chain>`),
// and reads take the max of both. This makes flipping MONERO_TXPOOL
// on/off a warm handoff in either direction instead of a cold start —
// max() is safe for a monotonic cursor even with KV's eventual
// consistency (worst case: a bounded re-scan, absorbed by ingest dedup).
// Mirror writes happen once per block pass (~1/min), far under KV limits.
function doSqliteWatcherStorage(
  state: DurableObjectState,
  cache: AppDeps["cache"],
  chainId: ChainId
): MoneroWatcherStorage {
  const sql = state.storage.sql;
  const mirrorKey = `monero:last_scanned_height:${chainId}`;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pool_seen (tx_hash TEXT PRIMARY KEY, first_seen_ms INTEGER NOT NULL)"
  );
  return {
    async filterSeen(hashes) {
      const out = new Set<string>();
      // Conservative chunk size — comfortably under every SQLite bound-
      // parameter limit variant; pool hash lists run to a few thousand
      // entries at worst, so this stays ≤ ~100 local queries per tick.
      const CHUNK = 50;
      for (let i = 0; i < hashes.length; i += CHUNK) {
        const chunk = hashes.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = sql
          .exec<{ tx_hash: string }>(
            `SELECT tx_hash FROM pool_seen WHERE tx_hash IN (${placeholders})`,
            ...chunk
          )
          .toArray();
        for (const row of rows) out.add(row.tx_hash);
      }
      return out;
    },
    async markSeen(hashes, nowMs) {
      for (const h of hashes) {
        sql.exec(
          "INSERT INTO pool_seen (tx_hash, first_seen_ms) VALUES (?, ?) ON CONFLICT(tx_hash) DO NOTHING",
          h,
          nowMs
        );
      }
    },
    async pruneSeen(olderThanMs) {
      sql.exec("DELETE FROM pool_seen WHERE first_seen_ms < ?", olderThanMs);
    },
    async getCheckpoint() {
      const local = await state.storage.get<number>("block_cursor");
      const mirrored = (await cache.getJSON<{ h: number }>(mirrorKey).catch(() => null))?.h;
      const candidates = [local, mirrored].filter((v): v is number => typeof v === "number");
      return candidates.length > 0 ? Math.max(...candidates) : null;
    },
    async setCheckpoint(height) {
      await state.storage.put("block_cursor", height);
      // Best-effort mirror — never let a KV hiccup fail the pass.
      await cache
        .putJSON(mirrorKey, { h: height }, { ttlSeconds: 60 * 60 * 24 * 365 })
        .catch(() => undefined);
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
