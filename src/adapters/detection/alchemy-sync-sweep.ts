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
}

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
    const now = nowFn();
    const claimed = await subscriptionStore.claimPending({
      now,
      backoffMs: retryBackoffMs,
      limit: batchLimit
    });
    if (claimed.length === 0) {
      return { claimed: 0, syncedChains: 0, skippedChains: 0, failedChains: 0, byChain: [] };
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

      const addresses_to_add = dedupe(rows.filter((r) => r.action === "add").map((r) => r.address));
      const addresses_to_remove = dedupe(rows.filter((r) => r.action === "remove").map((r) => r.address));
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
