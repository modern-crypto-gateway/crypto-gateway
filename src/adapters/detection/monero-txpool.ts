import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { AppDeps } from "../../core/app-deps.js";
import type { Address, ChainId } from "../../core/types/chain.js";
import type { CacheStore } from "../../core/ports/cache.port.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import {
  LATE_PAYMENT_WATCH_MS,
  PROCESSING_EXPIRY_GRACE_MS
} from "../../core/domain/payment-config.js";
import { invoices, invoiceReceiveAddresses } from "../../db/schema.js";
import {
  buildMoneroScanContext,
  matchMoneroTxOutputs,
  type MoneroChainAdapter
} from "../chains/monero/monero-chain.adapter.js";

// Monero instant detection: txpool polling + block-walk settlement.
//
// Why this exists: Monero has no address-watch push API anywhere — stealth
// addresses mean only the view-key holder can recognize an output, so
// services like mempool.space's `track-addresses` WebSocket structurally
// cannot exist for XMR (any service that scanned for you would need your
// private view key). The fastest detection primitive a public monerod
// exposes is `/get_transaction_pool_hashes`: a tiny JSON list of pool tx
// hashes. This watcher polls it every few seconds, diffs against a seen-set
// so only NEW hashes pay the fetch+scan cost, view-key-scans the new txs,
// and ingests hits at 0-conf — broadcast → `invoice.payment_detected`
// webhook in seconds. (This is the same architecture AcceptXMR, the
// reference Rust library for XMR payment detection, uses.)
//
// The pool pass is a LATENCY layer only. The BLOCK pass is the zero-miss
// settlement truth: it walks every block from a checkpoint (never skipping
// heights), so a payment that eluded the pool pass — node omission, pool
// eviction + re-mine, watcher downtime — is still detected at most one
// block-pass interval after it's mined. Both passes share the exact same
// pure matcher (`matchMoneroTxOutputs`), so they cannot drift apart
// cryptographically.
//
// Hosts drive `tick()` on their own scheduler:
//   - Cloudflare Workers: MoneroWatcherDO's self-rescheduling alarm
//     (~10 s active, ~60 s idle) — see entrypoints/monero-watcher-do.ts.
//   - Node: a plain setInterval at boot — see entrypoints/node.ts.
// Storage (seen-set + block cursor) is pluggable per host: DO SQLite on
// Workers (strongly consistent, no TTL), in-memory + CacheStore on Node.
//
// Checkpoint ordering invariant: the block cursor advances ONLY after the
// transfers from those blocks were handed to ingest. A crash between scan
// and ingest re-scans the same blocks next pass; the transactions table's
// (chain_id, tx_hash, log_index) UNIQUE constraint absorbs the re-ingest.

// Hard-fork version this scanner's cryptography supports. v16 = current
// mainnet (Fluorine Fermi line). The FCMP++/Carrot fork (v17+, realistic
// late 2026–H1 2027) redefines receive-side scanning — same view key +
// subaddresses, but X25519 ECDH, 3-byte view tags, and new amount
// encryption. The fork canary below alerts loudly the moment the network
// reports a newer version so the gateway never goes silently deaf on fork
// day. Track: github.com/monero-project/monero milestone "fcmp++ hf".
export const SUPPORTED_MONERO_HARD_FORK_VERSION = 16;

const DEFAULT_BLOCK_PASS_INTERVAL_MS = 60_000;
const DEFAULT_WATCHED_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BLOCKS_PER_PASS = 40;
const DEFAULT_TX_FETCH_BATCH = 25;
// Cap on new pool txs fetched+scanned in one tick. A cold start against a
// full mainnet pool (thousands of txs) processes the newest first and
// spreads the rest over subsequent ticks instead of blowing the tick's
// CPU/subrequest budget. Unprocessed hashes stay un-seen, so nothing is
// dropped — and every pool tx is re-checked by the block pass when mined.
const DEFAULT_MAX_NEW_POOL_TXS_PER_TICK = 1_500;
// Soft wall-clock budget for one tick's pool pass. Under a healthy fleet a
// pool pass is well under a second; this only bites on a cold-start influx
// or a degraded fleet where each getTransactions pays a failover walk. When
// exceeded, the pool pass defers its remainder and the block pass is
// skipped this tick, so a single tick never stretches to minutes and the
// active poll cadence holds. Deferral is lossless (unprocessed hashes stay
// un-seen; the block cursor never advances past an unscanned height).
const DEFAULT_TICK_BUDGET_MS = 8_000;
const SEEN_RETENTION_MS = 2 * 60 * 60 * 1000; // 2h ≫ typical pool residency
const FORK_CANARY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// Storage the host provides. Both stores are best-effort caches of chain
// state, not ledgers — losing them means re-scanning, never losing money.
export interface MoneroWatcherStorage {
  // Of `hashes`, return the subset already marked seen.
  filterSeen(hashes: readonly string[]): Promise<ReadonlySet<string>>;
  markSeen(hashes: readonly string[], nowMs: number): Promise<void>;
  pruneSeen(olderThanMs: number): Promise<void>;
  getCheckpoint(): Promise<number | null>;
  setCheckpoint(height: number): Promise<void>;
}

export interface MoneroTxpoolWatcherConfig {
  readonly deps: AppDeps;
  readonly adapter: MoneroChainAdapter;
  readonly chainId: ChainId;
  readonly storage: MoneroWatcherStorage;
  readonly blockPassIntervalMs?: number;
  readonly watchedRefreshIntervalMs?: number;
  readonly maxBlocksPerPass?: number;
  readonly txFetchBatch?: number;
  readonly maxNewPoolTxsPerTick?: number;
  readonly tickBudgetMs?: number;
}

export interface MoneroTickResult {
  // False when zero live XMR invoices are watched — the host should back
  // off to its idle cadence.
  readonly active: boolean;
  readonly watchedAddresses: number;
  readonly poolNewTxs: number;
  readonly poolMatched: number;
  readonly blocksScanned: number;
  readonly blockMatched: number;
}

export interface MoneroTxpoolWatcher {
  // Force a watched-set re-query now (invoice created/settled in another
  // isolate — the DO's /ensure poke calls this, mirroring the UTXO
  // watcher's refresh()).
  refreshWatchedSet(): Promise<number>;
  // One scheduling quantum: refresh watched set if stale, pool pass, block
  // pass if due, fork canary if due. Idempotent; safe to overlap-guard at
  // the host level (the DO alarm and Node interval both serialize ticks).
  tick(): Promise<MoneroTickResult>;
  status(): {
    watchedAddresses: number;
    lastPoolPassAt: number | null;
    lastBlockPassAt: number | null;
    checkpointCache: number | null;
  };
}

export function moneroTxpoolWatcher(config: MoneroTxpoolWatcherConfig): MoneroTxpoolWatcher {
  const { deps, adapter, chainId, storage } = config;
  const logger = deps.logger;
  const blockPassIntervalMs = config.blockPassIntervalMs ?? DEFAULT_BLOCK_PASS_INTERVAL_MS;
  const watchedRefreshIntervalMs =
    config.watchedRefreshIntervalMs ?? DEFAULT_WATCHED_REFRESH_INTERVAL_MS;
  const maxBlocksPerPass = config.maxBlocksPerPass ?? DEFAULT_MAX_BLOCKS_PER_PASS;
  const txFetchBatch = config.txFetchBatch ?? DEFAULT_TX_FETCH_BATCH;
  const maxNewPoolTxsPerTick = config.maxNewPoolTxsPerTick ?? DEFAULT_MAX_NEW_POOL_TXS_PER_TICK;
  const tickBudgetMs = config.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const client = adapter.moneroDaemonClient;

  let watched: readonly Address[] = [];
  let lastWatchedRefreshAt = 0;
  let lastPoolPassAt: number | null = null;
  let lastBlockPassAt = 0;
  let lastForkCanaryAt = 0;
  let checkpointCache: number | null = null;

  // Same live-invoice window as pollPayments: pending/completed inside the
  // expiry window, processing through the grace window, expired through the
  // late-payment watch window. Monero-family rows only.
  async function refreshWatchedSet(): Promise<number> {
    const nowMs = deps.clock.now().getTime();
    const rows = await deps.db
      .select({ address: invoiceReceiveAddresses.address })
      .from(invoices)
      .innerJoin(invoiceReceiveAddresses, eq(invoiceReceiveAddresses.invoiceId, invoices.id))
      .where(
        and(
          eq(invoiceReceiveAddresses.family, "monero"),
          or(
            and(
              inArray(invoices.status, ["pending", "completed"]),
              gt(invoices.expiresAt, nowMs)
            ),
            and(
              eq(invoices.status, "processing"),
              gt(invoices.expiresAt, nowMs - PROCESSING_EXPIRY_GRACE_MS)
            ),
            and(
              eq(invoices.status, "expired"),
              gt(invoices.expiresAt, nowMs - LATE_PAYMENT_WATCH_MS)
            )
          )
        )
      );
    const set = new Set<string>();
    for (const r of rows) set.add(r.address);
    watched = Array.from(set) as Address[];
    lastWatchedRefreshAt = nowMs;
    return watched.length;
  }

  // Ingest a batch of transfers. Individual failures are logged and
  // retried on the next pass — the failed tx is not marked seen (pool
  // pass) and the block cursor stays behind its block (block pass).
  async function ingestAll(
    transfers: readonly DetectedTransfer[]
  ): Promise<{ failedTxHashes: Set<string>; ingested: number }> {
    const failedTxHashes = new Set<string>();
    let ingested = 0;
    for (const transfer of transfers) {
      try {
        const result = await ingestDetectedTransfer(deps, transfer);
        if (result.inserted) ingested += 1;
      } catch (err) {
        failedTxHashes.add(transfer.txHash);
        logger.warn("monero-txpool: ingest failed; will retry next pass", {
          chainId,
          txHash: transfer.txHash,
          logIndex: transfer.logIndex,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return { failedTxHashes, ingested };
  }

  // Pool pass: hash diff → fetch new → scan → ingest at 0-conf. `deadlineMs`
  // is an absolute wall-clock stop: under a degraded fleet each
  // getTransactions can pay a multi-second failover walk, and a cold start
  // has up to maxNewPoolTxsPerTick to process — without a deadline a single
  // tick could stretch to minutes. Breaking early loses nothing: unfetched
  // hashes are never markSeen'd, so the next tick retries them. `deferred`
  // signals the caller to skip this tick's block pass so two slow passes
  // don't stack.
  async function poolPass(
    nowMs: number,
    deadlineMs: number
  ): Promise<{ poolNewTxs: number; poolMatched: number; deferred: boolean }> {
    const hashes = await client.getTxPoolHashes();
    lastPoolPassAt = nowMs;
    if (hashes.length === 0) return { poolNewTxs: 0, poolMatched: 0, deferred: false };
    const seen = await storage.filterSeen(hashes);
    let fresh = hashes.filter((h) => !seen.has(h));
    if (fresh.length === 0) return { poolNewTxs: 0, poolMatched: 0, deferred: false };
    let deferred = false;
    if (fresh.length > maxNewPoolTxsPerTick) {
      logger.warn("monero-txpool: pool influx exceeds per-tick cap; deferring remainder", {
        chainId,
        fresh: fresh.length,
        cap: maxNewPoolTxsPerTick
      });
      fresh = fresh.slice(0, maxNewPoolTxsPerTick);
      deferred = true;
    }

    const ctx = buildMoneroScanContext({
      chainId,
      viewKey: adapter.moneroViewKey,
      addresses: watched,
      logger
    });

    let matchedCount = 0;
    let processed = 0;
    const seenAt = new Date(nowMs);
    for (let i = 0; i < fresh.length; i += txFetchBatch) {
      if (deps.clock.now().getTime() >= deadlineMs) {
        // Wall-clock budget spent — defer the rest. Unprocessed hashes stay
        // un-seen and retry next tick; the block pass is skipped so it
        // doesn't pile onto an already-slow tick.
        logger.warn("monero-txpool: tick budget exceeded mid pool-pass; deferring remainder", {
          chainId,
          processed,
          remaining: fresh.length - i
        });
        deferred = true;
        break;
      }
      const batch = fresh.slice(i, i + txFetchBatch);
      let txs;
      try {
        txs = await client.getTransactions(batch);
      } catch (err) {
        // Backend trouble mid-pass: stop here. Unfetched hashes were never
        // marked seen, so the next tick retries them.
        logger.warn("monero-txpool: pool tx fetch failed; deferring remainder to next tick", {
          chainId,
          batchStart: i,
          error: err instanceof Error ? err.message : String(err)
        });
        deferred = true;
        break;
      }
      const transfers = txs.flatMap((tx) =>
        matchMoneroTxOutputs(ctx, tx, {
          fallbackBlockHeight: null, // pool txs: blockNumber null, 0 conf
          tipHeight: null,
          seenAt
        })
      );
      matchedCount += transfers.length;
      const { failedTxHashes } = await ingestAll(transfers);
      // Mark the batch seen — EXCEPT txs whose ingest failed, so they're
      // re-scanned next tick. (Txs evicted between hash-list and fetch are
      // absent from `txs`; mark them seen too — if they come back or get
      // mined, the block pass still covers them.)
      const toMark = batch.filter((h) => !failedTxHashes.has(h));
      if (toMark.length > 0) await storage.markSeen(toMark, nowMs);
      processed += batch.length;
    }
    await storage.pruneSeen(nowMs - SEEN_RETENTION_MS);
    return { poolNewTxs: fresh.length, poolMatched: matchedCount, deferred };
  }

  // Block pass: walk from the cursor, never skipping a height while
  // anything is watched. Cursor advances only past blocks whose transfers
  // all reached ingest.
  async function blockPass(nowMs: number): Promise<{ blocksScanned: number; blockMatched: number }> {
    lastBlockPassAt = nowMs;
    let checkpoint = await storage.getCheckpoint();
    if (checkpoint === null) {
      const tip = await client.getTipHeight();
      // Cold start: honor an explicit MONERO_RESTORE_HEIGHT backfill point,
      // else start a few hours back (tip-100) — same footgun guard as the
      // poll path's cold start.
      checkpoint = adapter.moneroRestoreHeight > 0
        ? adapter.moneroRestoreHeight - 1
        : Math.max(0, tip - 100);
      logger.info("monero-txpool: cold-start block cursor", { chainId, startAfterHeight: checkpoint });
    }

    const range = await adapter.scanBlockRange({
      addresses: watched,
      fromHeight: checkpoint + 1,
      maxBlocks: maxBlocksPerPass
    });
    if (range.scannedTo <= checkpoint) {
      checkpointCache = checkpoint;
      return { blocksScanned: 0, blockMatched: 0 };
    }

    const { failedTxHashes, ingested } = await ingestAll(range.transfers);
    // Advance the cursor, but never past the block BEFORE the lowest block
    // holding a failed ingest — those blocks get re-scanned next pass.
    let advanceTo = range.scannedTo;
    if (failedTxHashes.size > 0) {
      for (const t of range.transfers) {
        if (failedTxHashes.has(t.txHash) && t.blockNumber !== null) {
          advanceTo = Math.min(advanceTo, t.blockNumber - 1);
        }
      }
    }
    if (advanceTo > checkpoint) {
      await storage.setCheckpoint(advanceTo);
      checkpointCache = advanceTo;
    } else {
      checkpointCache = checkpoint;
    }

    const lag = range.tipHeight - (checkpointCache ?? 0);
    if (lag > 200) {
      logger.warn("monero-txpool: block cursor lagging tip; catching up WITHOUT skipping blocks", {
        chainId,
        checkpoint: checkpointCache,
        tipHeight: range.tipHeight,
        gapBlocks: lag
      });
    }
    void ingested;
    return {
      blocksScanned: Math.max(0, range.scannedTo - checkpoint),
      blockMatched: range.transfers.length
    };
  }

  // Idle housekeeping: with nothing watched, nothing in these blocks can
  // match (detection requires a watched invoice_receive_addresses row, and
  // the watched window already covers processing-grace + late-payment
  // watch). Fast-forward the cursor so the next live invoice starts
  // scanning from the present instead of walking a dead gap.
  //
  // Two guards against fast-forwarding past a payment we should have seen:
  //   1. Callers only invoke this when THIS tick's watched-set refresh
  //      succeeded — a stale "empty" set from a failed DB query must never
  //      justify skipping blocks.
  //   2. Leave a 3-block margin below tip (~6 min). An invoice created in
  //      the instant between the refresh query and this write can't have a
  //      payment MINED inside that margin (customers can't pay an address
  //      before it exists, and Monero blocks land ~2 min apart), so the
  //      next active block pass always starts early enough to cover it.
  const IDLE_FAST_FORWARD_MARGIN_BLOCKS = 3;
  async function idleFastForward(): Promise<void> {
    try {
      const tip = await client.getTipHeight();
      const target = Math.max(0, tip - IDLE_FAST_FORWARD_MARGIN_BLOCKS);
      const current = await storage.getCheckpoint();
      if (current === null || target > current) {
        await storage.setCheckpoint(target);
        checkpointCache = target;
      } else {
        checkpointCache = current;
      }
    } catch (err) {
      logger.debug("monero-txpool: idle fast-forward skipped (tip fetch failed)", {
        chainId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Fork canary: alert loudly when the network's hard-fork version exceeds
  // what this scanner's cryptography supports (see constant above).
  async function forkCanary(nowMs: number): Promise<void> {
    if (nowMs - lastForkCanaryAt < FORK_CANARY_INTERVAL_MS) return;
    lastForkCanaryAt = nowMs;
    const version = await client.getHardForkVersion?.();
    if (typeof version === "number" && version > SUPPORTED_MONERO_HARD_FORK_VERSION) {
      logger.error(
        "monero-txpool: network hard-fork version exceeds supported version — post-fork payments will NOT be detected until the scanner is upgraded (FCMP++/Carrot changes receive-side scanning)",
        { chainId, networkVersion: version, supportedVersion: SUPPORTED_MONERO_HARD_FORK_VERSION }
      );
    }
  }

  return {
    refreshWatchedSet,

    async tick() {
      const nowMs = deps.clock.now().getTime();
      let refreshOk = true;
      if (nowMs - lastWatchedRefreshAt >= watchedRefreshIntervalMs) {
        try {
          await refreshWatchedSet();
        } catch (err) {
          // DB hiccup: keep the previous watched set — stale coverage beats
          // a blind tick.
          refreshOk = false;
          logger.warn("monero-txpool: watched-set refresh failed; using previous set", {
            chainId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      if (watched.length === 0) {
        // Fast-forward ONLY on a fresh, successful refresh — an "empty" set
        // left over from a failed DB query must never justify skipping
        // blocks (an invoice might have been created since the last good
        // read, and its payment could be mined in the skipped range).
        if (refreshOk) {
          await idleFastForward();
        }
        return {
          active: false,
          watchedAddresses: 0,
          poolNewTxs: 0,
          poolMatched: 0,
          blocksScanned: 0,
          blockMatched: 0
        };
      }

      // Per-tick wall-clock budget shared by both passes: keeps a slow
      // failover fleet or a cold-start influx from stretching one tick into
      // minutes and collapsing the active poll cadence.
      const deadlineMs = nowMs + tickBudgetMs;

      // Pool pass every tick; isolate failures so one pass can't silence
      // the other (mirrors pollPayments' per-chain isolation).
      let poolNewTxs = 0;
      let poolMatched = 0;
      let poolDeferred = false;
      try {
        const pool = await poolPass(nowMs, deadlineMs);
        poolNewTxs = pool.poolNewTxs;
        poolMatched = pool.poolMatched;
        poolDeferred = pool.deferred;
      } catch (err) {
        logger.warn("monero-txpool: pool pass failed; block pass still runs", {
          chainId,
          error: err instanceof Error ? err.message : String(err)
        });
      }

      let blocksScanned = 0;
      let blockMatched = 0;
      // Run the block pass only if it's due AND the pool pass left budget.
      // Skipping when the pool deferred (cap hit / budget spent) prevents two
      // multi-second passes stacking on one tick; lastBlockPassAt isn't
      // updated, so the pass stays due and runs next tick — the block layer
      // is latency-tolerant (it's the settlement backstop, not the instant
      // path), so deferring it one tick loses nothing.
      const blockPassDue = nowMs - lastBlockPassAt >= blockPassIntervalMs;
      const budgetLeft = deps.clock.now().getTime() < deadlineMs;
      if (blockPassDue && !poolDeferred && budgetLeft) {
        try {
          const blocks = await blockPass(nowMs);
          blocksScanned = blocks.blocksScanned;
          blockMatched = blocks.blockMatched;
        } catch (err) {
          logger.warn("monero-txpool: block pass failed; next tick retries", {
            chainId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      } else if (blockPassDue) {
        logger.debug("monero-txpool: block pass deferred (pool pass consumed tick budget)", {
          chainId,
          poolDeferred,
          budgetLeft
        });
      }

      try {
        await forkCanary(nowMs);
      } catch {
        // canary is best-effort by design
      }

      if (poolMatched > 0 || blockMatched > 0) {
        logger.info("monero-txpool: tick detected transfers", {
          chainId,
          watchedAddresses: watched.length,
          poolNewTxs,
          poolMatched,
          blocksScanned,
          blockMatched
        });
      }

      return {
        active: true,
        watchedAddresses: watched.length,
        poolNewTxs,
        poolMatched,
        blocksScanned,
        blockMatched
      };
    },

    status() {
      return {
        watchedAddresses: watched.length,
        lastPoolPassAt,
        lastBlockPassAt: lastBlockPassAt === 0 ? null : lastBlockPassAt,
        checkpointCache
      };
    }
  };
}

// In-memory seen-set + CacheStore-backed checkpoint. Used by the Node
// entrypoint's in-process watcher (long-lived process: the seen-set only
// resets on restart, and a restart's full-pool re-scan is absorbed by the
// transactions table's dedup). The checkpoint shares the SAME cache key as
// the adapter's poll-path cursor so the two never double-scan when a
// deployment switches modes.
export function memoryCacheWatcherStorage(
  cache: CacheStore,
  chainId: ChainId
): MoneroWatcherStorage {
  const seen = new Map<string, number>();
  const checkpointKey = `monero:last_scanned_height:${chainId}`;
  return {
    async filterSeen(hashes) {
      const out = new Set<string>();
      for (const h of hashes) if (seen.has(h)) out.add(h);
      return out;
    },
    async markSeen(hashes, nowMs) {
      for (const h of hashes) seen.set(h, nowMs);
    },
    async pruneSeen(olderThanMs) {
      for (const [h, ts] of seen) {
        if (ts < olderThanMs) seen.delete(h);
      }
    },
    async getCheckpoint() {
      const v = await cache.getJSON<{ h: number }>(checkpointKey);
      return v?.h ?? null;
    },
    async setCheckpoint(height) {
      await cache.putJSON(checkpointKey, { h: height }, { ttlSeconds: 60 * 60 * 24 * 365 });
    }
  };
}
