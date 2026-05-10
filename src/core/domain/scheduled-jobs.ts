import type { AppDeps } from "../app-deps.js";
import { runAutoConsolidations } from "./auto-consolidation.service.js";
import { sweepExpiredInvoices } from "./invoice.service.js";
import { confirmTransactions, recheckConfirmedTransactionsForReorg } from "./payment.service.js";
import {
  confirmPayouts,
  executeReservedPayouts,
  reconcileFailedPayoutGasBurns,
  sweepStuckPayoutReservations
} from "./payout.service.js";
import { pollPayments } from "./poll-payments.js";
import { reconcileOrphanedAllocations } from "./pool.service.js";
import { warmRateCache } from "./rate-window.js";
import { sweepWebhookDeliveries } from "./webhook-subscriber.js";

// Runs every scheduled job in sequence. Shared between the Workers `scheduled`
// export, the Node cron runner, `Deno.cron`, and the Vercel Cron HTTP trigger —
// any scheduler can invoke this and get the same behavior, no duplicated
// per-runtime plumbing.
//
// Jobs run sequentially on purpose: confirmations only make sense after
// detections are ingested, and payout submissions only after that. Any single
// job failing logs + continues; the runner catches and reports per-job so one
// slow/failing RPC can't deny-of-service the others.
//
// CPU budget on Workers: the whole sequence must fit in 30s CPU. Each sweep
// function caps its batch (`maxBatch` option) so a backlog can't blow past
// the limit — partial progress is safe because the cron re-invokes
// frequently. Tune via scheduled-jobs callers if your tick rate or per-row
// cost differs from the defaults (200 payouts / 200 txs / 100 webhooks).

export interface ScheduledJobsResult {
  warmRateCache: JobOutcome;
  pollPayments: JobOutcome;
  confirmTransactions: JobOutcome;
  recheckConfirmedForReorg: JobOutcome;
  executeReservedPayouts: JobOutcome;
  confirmPayouts: JobOutcome;
  reconcileFailedPayoutGasBurns: JobOutcome;
  sweepStuckPayoutReservations: JobOutcome;
  sweepExpiredInvoices: JobOutcome;
  reconcileOrphanedAllocations: JobOutcome;
  sweepWebhookDeliveries: JobOutcome;
  // Auto-consolidation: fires due `(chainId, token)` consolidation
  // schedules. No env gate — table-driven; with no schedules configured
  // this is a single indexed lookup that finds nothing.
  runAutoConsolidations: JobOutcome;
  // Present only when Alchemy is configured for this deployment
  // (`deps.alchemy` set). Absent otherwise — callers should not treat the
  // missing key as a failure.
  alchemySyncAddresses?: JobOutcome;
  // Present only when BlockCypher is configured (`deps.blockcypher` set).
  // Drains the `blockcypher_subscriptions` queue per tick.
  blockcypherSyncSubscriptions?: JobOutcome;
}

export type JobOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export async function runScheduledJobs(deps: AppDeps): Promise<ScheduledJobsResult> {
  const result: ScheduledJobsResult = {
    // Pre-warm the price-oracle cache so USD-pegged invoice creation in the
    // next minute reads warm cache instead of paying upstream latency on
    // its critical path. Single batched call covers every token symbol any
    // wired family might need to price; oracle outage is non-fatal (the
    // SWR layer keeps serving stale rates until the next tick recovers).
    warmRateCache: await run(() => warmRateCache(deps)),
    pollPayments: await run(() => pollPayments(deps)),
    confirmTransactions: await run(() => confirmTransactions(deps)),
    // Reorg safety net — runs after confirmTransactions so a tx confirmed
    // this tick and reorged out next tick still gets caught promptly.
    recheckConfirmedForReorg: await run(() => recheckConfirmedTransactionsForReorg(deps)),
    executeReservedPayouts: await run(() => executeReservedPayouts(deps)),
    confirmPayouts: await run(() => confirmPayouts(deps)),
    // Gas-burn reconciliation: retry `gas_burn` synthesis for any
    // failed-and-broadcast payout whose receipt wasn't yet visible to
    // the RPC at fail-time. Without this, transient RPC lag at the
    // moment of failure permanently loses the burn from the ledger,
    // causing the next plan to reuse a now-underfunded source. Runs
    // AFTER confirmPayouts so any payout that just flipped to failed
    // this tick gets a same-tick retry on its gas_burn.
    reconcileFailedPayoutGasBurns: await run(() => reconcileFailedPayoutGasBurns(deps)),
    sweepStuckPayoutReservations: await run(() => sweepStuckPayoutReservations(deps)),
    // Expire-then-deliver: must run BEFORE sweepWebhookDeliveries so the
    // invoice.expired events published here insert webhook rows that get
    // picked up in the same tick. (Initial dispatch still happens via
    // dispatchEvent; the sweeper is the safety net.)
    sweepExpiredInvoices: await run(() => sweepExpiredInvoices(deps)),
    // Defense-in-depth pool sweep: runs AFTER sweepExpiredInvoices so any
    // address whose invoice was just flipped to 'expired' but didn't release
    // via the event bus (process crash between event publish and subscriber
    // callback) gets caught here on the same tick. Honors a grace window so
    // an in-flight create-invoice flow isn't raced.
    reconcileOrphanedAllocations: await run(() => reconcileOrphanedAllocations(deps)),
    sweepWebhookDeliveries: await run(() => sweepWebhookDeliveries(deps)),
    // Runs AFTER reconcileOrphanedAllocations so any address just freed
    // up by the orphan sweep is visible to the consolidation source-
    // discovery query. Cheap when no schedules exist (single indexed
    // lookup); per-tick cost scales with number of due schedules.
    runAutoConsolidations: await run(() => runAutoConsolidations(deps))
  };
  if (deps.alchemy !== undefined) {
    result.alchemySyncAddresses = await run(() => deps.alchemy!.syncAddresses());
  }
  if (deps.blockcypher !== undefined) {
    result.blockcypherSyncSubscriptions = await run(() => deps.blockcypher!.syncSubscriptions());
  }
  return result;
}

async function run<T>(fn: () => Promise<T>): Promise<JobOutcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scheduled-jobs] step failed:", message);
    return { ok: false, error: message };
  }
}
