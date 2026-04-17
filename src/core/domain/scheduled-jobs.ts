import type { AppDeps } from "../app-deps.js";
import { confirmTransactions } from "./payment.service.js";
import {
  confirmPayouts,
  executeReservedPayouts,
  sweepStuckFeeWalletReservations
} from "./payout.service.js";
import { pollPayments } from "./poll-payments.js";
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

export interface ScheduledJobsResult {
  pollPayments: JobOutcome;
  confirmTransactions: JobOutcome;
  executeReservedPayouts: JobOutcome;
  confirmPayouts: JobOutcome;
  sweepStuckFeeWalletReservations: JobOutcome;
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
    executeReservedPayouts: await run(() => executeReservedPayouts(deps)),
    confirmPayouts: await run(() => confirmPayouts(deps)),
    sweepStuckFeeWalletReservations: await run(() => sweepStuckFeeWalletReservations(deps)),
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
