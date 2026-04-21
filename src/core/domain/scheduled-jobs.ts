import type { AppDeps } from "../app-deps.js";
import { sweepExpiredInvoices } from "./invoice.service.js";
import { confirmTransactions, recheckConfirmedTransactionsForReorg } from "./payment.service.js";
import {
  confirmPayouts,
  executeReservedPayouts,
  sweepStuckPayoutReservations
} from "./payout.service.js";
import { pollPayments } from "./poll-payments.js";
import { reconcileOrphanedAllocations } from "./pool.service.js";
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
  pollPayments: JobOutcome;
  confirmTransactions: JobOutcome;
  recheckConfirmedForReorg: JobOutcome;
  executeReservedPayouts: JobOutcome;
  confirmPayouts: JobOutcome;
  sweepStuckPayoutReservations: JobOutcome;
  sweepExpiredInvoices: JobOutcome;
  reconcileOrphanedAllocations: JobOutcome;
  sweepWebhookDeliveries: JobOutcome;
  // Present only when Alchemy is configured for this deployment
  // (`deps.alchemy` set). Absent otherwise — callers should not treat the
  // missing key as a failure.
  alchemySyncAddresses?: JobOutcome;
}

export type JobOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export async function runScheduledJobs(deps: AppDeps): Promise<ScheduledJobsResult> {
  const result: ScheduledJobsResult = {
    pollPayments: await run(() => pollPayments(deps)),
    confirmTransactions: await run(() => confirmTransactions(deps)),
    // Reorg safety net — runs after confirmTransactions so a tx confirmed
    // this tick and reorged out next tick still gets caught promptly.
    recheckConfirmedForReorg: await run(() => recheckConfirmedTransactionsForReorg(deps)),
    executeReservedPayouts: await run(() => executeReservedPayouts(deps)),
    confirmPayouts: await run(() => confirmPayouts(deps)),
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
    sweepWebhookDeliveries: await run(() => sweepWebhookDeliveries(deps))
  };
  if (deps.alchemy !== undefined) {
    result.alchemySyncAddresses = await run(() => deps.alchemy!.syncAddresses());
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
