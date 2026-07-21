import type { CacheStore } from "../../core/ports/cache.port.js";
import type { Logger } from "../../core/ports/logger.port.js";
import type { AlchemyAdminClient } from "./alchemy-admin-client.js";
import type { AlchemyRegistryStore } from "./alchemy-registry-store.js";
import type { AlchemySubscriptionStore, SubscriptionRow } from "./alchemy-subscription-store.js";

// Cron-triggered sweep. Claims pending subscription rows, groups by chain,
// batches one `/update-webhook-addresses` call per chain with both
// addresses_to_add and addresses_to_remove, then marks the rows synced
// (or bumps `attempts` on failure).
//
// Design choices vs v1:
//   - Max attempts cap (default 10). After the cap, row moves to 'failed'.
//     v1 retried forever, which made an Alchemy outage look identical to a
//     permanently malformed address — operators couldn't tell when to stop
//     waiting. 'failed' = "you need to look at this".
//   - 5-minute backoff between attempts per row.
//   - Chains with no registry row (webhook not bootstrapped yet) are skipped
//     without bumping `attempts` — bootstrap is the fix, not retry pressure.
//   - Batch cap (default 500 per sweep) to bound a single cron's API spend.
//
// With pool auto-shrink the queue rows are best understood as DIRTY MARKERS,
// not commands: the same address can accumulate add and remove rows in any
// order (retire → reactivate → retire …), across different claim batches and
// retry backoffs. Replaying them in row order can apply a stale `remove`
// after a newer `add` and silently deregister an address the DB considers
// watched — with no queue row left to heal it. So when `resolveWatchIntent`
// is wired, the sweep re-derives the DESIRED action for every claimed
// address from the address_pool source of truth at sweep time; every
// lifecycle transition enqueues its marker AFTER committing, so the last
// transition always leaves a pending row that a later sweep resolves against
// final state — eventual convergence regardless of enqueue/claim ordering.

export interface AlchemySyncSweepConfig {
  adminClient: AlchemyAdminClient;
  registryStore: AlchemyRegistryStore;
  subscriptionStore: AlchemySubscriptionStore;
  logger: Logger;
  now?: () => number;
  // Max subscription rows to claim per sweep. Prevents a bootstrap of
  // thousands of existing invoices from spiking Alchemy's API. Default 500.
  batchLimit?: number;
  // Per-row backoff before retry after a failure, ms. Default 5 min.
  retryBackoffMs?: number;
  // Attempts at which a row flips to 'failed' (stops retrying). Default 10.
  maxAttempts?: number;
  // Source-of-truth resolver: given claimed addresses, returns the subset
  // that SHOULD currently be watched (address_pool row exists with
  // retired_at NULL). When present, each claimed address syncs to this
  // intent instead of replaying row order. See poolWatchIntentResolver.
  resolveWatchIntent?: (addresses: readonly string[]) => Promise<ReadonlySet<string>>;
  // Advisory mutex serializing sweep runs. The claim query does not lock
  // rows (single-cron assumption); pool-lifecycle "kicks" now start extra
  // sweeps, so overlapping runs could each PATCH stale views of the same
  // address. A kicked sweep that loses the lock just returns — the pending
  // rows survive for the next cron tick.
  cache?: CacheStore;
}

const SWEEP_LOCK_KEY = "alchemy:sync-sweep-lock";
const SWEEP_LOCK_TTL_SECONDS = 60;

export interface AlchemySyncSweepResult {
  claimed: number;
  syncedChains: number;
  skippedChains: number; // chains with pending rows but no registry webhook
  failedChains: number;
  // Breakdown: per-chain "what happened"
  byChain: Array<{
    chainId: number;
    status: "synced" | "skipped-no-webhook" | "failed";
    addCount: number;
    removeCount: number;
    error?: string;
  }>;
}

const DEFAULT_BATCH_LIMIT = 500;
const DEFAULT_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 10;

export function makeAlchemySyncSweep(config: AlchemySyncSweepConfig): () => Promise<AlchemySyncSweepResult> {
  const { adminClient, registryStore, subscriptionStore, logger } = config;
  const nowFn = config.now ?? (() => Date.now());
  const batchLimit = config.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const retryBackoffMs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return async function syncAddresses(): Promise<AlchemySyncSweepResult> {
    const empty: AlchemySyncSweepResult = {
      claimed: 0,
      syncedChains: 0,
      skippedChains: 0,
      failedChains: 0,
      byChain: []
    };
    if (config.cache !== undefined) {
      const acquired = await config.cache.putIfAbsent(SWEEP_LOCK_KEY, "1", {
        ttlSeconds: SWEEP_LOCK_TTL_SECONDS
      });
      if (!acquired) return empty;
    }
    try {
      return await syncAddressesLocked();
    } finally {
      if (config.cache !== undefined) await config.cache.delete(SWEEP_LOCK_KEY);
    }
  };

  async function syncAddressesLocked(): Promise<AlchemySyncSweepResult> {
    const now = nowFn();
    const claimed = await subscriptionStore.claimPending({
      now,
      backoffMs: retryBackoffMs,
      limit: batchLimit
    });
    if (claimed.length === 0) {
      return { claimed: 0, syncedChains: 0, skippedChains: 0, failedChains: 0, byChain: [] };
    }

    // Source-of-truth resolution: one lookup for every distinct claimed
    // address (chain-independent — pool rows are per-family, and the intent
    // "watched vs not" is identical for every chain fanned out from it).
    let watchedSet: ReadonlySet<string> | null = null;
    if (config.resolveWatchIntent !== undefined) {
      const distinct = [...new Set(claimed.map((r) => r.address))];
      try {
        watchedSet = await config.resolveWatchIntent(distinct);
      } catch (err) {
        // Resolver outage → fall back to row-order replay rather than
        // stalling the queue; the next sweep re-resolves.
        logger.warn("alchemy sync: watch-intent resolver failed, using row order", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Group by chainId.
    const byChainId = new Map<number, SubscriptionRow[]>();
    for (const row of claimed) {
      const bucket = byChainId.get(row.chainId) ?? [];
      bucket.push(row);
      byChainId.set(row.chainId, bucket);
    }

    const perChain: AlchemySyncSweepResult["byChain"] = [];
    let syncedChains = 0;
    let skippedChains = 0;
    let failedChains = 0;

    for (const [chainId, rows] of byChainId) {
      const registration = await registryStore.findByChainId(chainId);
      if (registration === null) {
        // No webhook bootstrapped for this chain yet. Leave rows pending
        // (don't bump attempts) so bootstrap-then-sweep works without
        // burning through max-attempts.
        logger.warn("alchemy sync: no registry row for chain, skipping", { chainId, rows: rows.length });
        perChain.push({
          chainId,
          status: "skipped-no-webhook",
          addCount: rows.filter((r) => r.action === "add").length,
          removeCount: rows.filter((r) => r.action === "remove").length
        });
        skippedChains += 1;
        continue;
      }

      // Effective action per address. Primary: the DB watch intent resolved
      // above — queue rows are dirty markers, the DB is the truth, so retire/
      // reactivate flapping across batches and backoffs always converges to
      // the final state. Fallback (resolver absent/failed): newest-wins by
      // createdAt within the batch, tie keeps `add` — the safe direction
      // (worst case we keep watching an address we meant to drop until the
      // next retire pass).
      let addresses_to_add: string[];
      let addresses_to_remove: string[];
      if (watchedSet !== null) {
        const distinct = dedupe(rows.map((r) => r.address));
        addresses_to_add = distinct.filter((a) => watchedSet.has(a));
        addresses_to_remove = distinct.filter((a) => !watchedSet.has(a));
      } else {
        const effective = new Map<string, SubscriptionRow>();
        for (const row of rows) {
          const prior = effective.get(row.address);
          if (
            prior === undefined ||
            row.createdAt.getTime() > prior.createdAt.getTime() ||
            (row.createdAt.getTime() === prior.createdAt.getTime() && row.action === "add")
          ) {
            effective.set(row.address, row);
          }
        }
        addresses_to_add = dedupe(
          [...effective.values()].filter((r) => r.action === "add").map((r) => r.address)
        );
        addresses_to_remove = dedupe(
          [...effective.values()].filter((r) => r.action === "remove").map((r) => r.address)
        );
      }
      const ids = rows.map((r) => r.id);

      try {
        await adminClient.updateWebhookAddresses({
          webhookId: registration.webhookId,
          addressesToAdd: addresses_to_add,
          addressesToRemove: addresses_to_remove
        });
        await subscriptionStore.markSynced(ids, now);
        logger.info("alchemy sync: batched update succeeded", {
          chainId,
          webhookId: registration.webhookId,
          added: addresses_to_add.length,
          removed: addresses_to_remove.length
        });
        perChain.push({
          chainId,
          status: "synced",
          addCount: addresses_to_add.length,
          removeCount: addresses_to_remove.length
        });
        syncedChains += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await subscriptionStore.markAttempted({ ids, now, error: message, maxAttempts });
        logger.error("alchemy sync: batched update failed", {
          chainId,
          webhookId: registration.webhookId,
          rows: rows.length,
          error: message
        });
        perChain.push({
          chainId,
          status: "failed",
          addCount: addresses_to_add.length,
          removeCount: addresses_to_remove.length,
          error: message
        });
        failedChains += 1;
      }
    }

    return { claimed: claimed.length, syncedChains, skippedChains, failedChains, byChain: perChain };
  };
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
