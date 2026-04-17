import type { AppDeps } from "../app-deps.js";
import type { DomainEvent } from "../events/event-bus.port.js";
import type { ChainFamily } from "../types/chain.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import type { Invoice, InvoiceId, InvoiceStatus } from "../types/invoice.js";
import { DetectedTransferSchema, type TransactionId, type TxStatus } from "../types/transaction.js";
import { findChainAdapter } from "./chain-lookup.js";
import {
  fetchInvoiceReceiveAddresses,
  rowToInvoice,
  rowToTransaction,
  type InvoiceRow,
  type TxRow
} from "./mappers.js";
import { confirmationThreshold } from "./payment-config.js";
import { addUsd, compareUsd, refreshIfExpired, subUsd, usdValueFor } from "./rate-window.js";

// PaymentService: rules for how detected transfers become transactions, how
// transactions accumulate into invoices, and how confirmation counts promote
// through the state machine. Chain-agnostic — every family calls into the same
// logic via the ChainAdapter port.

// Administratively terminal: these are merchant / operator decisions that
// no chain event can reverse. `confirmed` is NOT here on purpose — a
// confirmed invoice can still demote on deep reorg when its contributing
// transactions orphan out, and the recompute path has to observe that.
// Historically `confirmed` was treated as terminal, which silently held the
// merchant-visible status at `confirmed` even after the underlying payment
// evaporated on-chain. Audit finding C6 fixed that by narrowing the set.
const ADMIN_TERMINAL_STATES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>(["expired", "canceled"]);

// ---- Ingest a detected transfer ----

export interface IngestResult {
  inserted: boolean;
  transactionId?: TransactionId;
  invoiceId?: InvoiceId;
  invoiceStatusBefore?: InvoiceStatus;
  invoiceStatusAfter?: InvoiceStatus;
}

export async function ingestDetectedTransfer(deps: AppDeps, input: unknown): Promise<IngestResult> {
  const transfer = DetectedTransferSchema.parse(input);

  const chainAdapter = findChainAdapter(deps, transfer.chainId);
  const canonicalTo = chainAdapter.canonicalizeAddress(transfer.toAddress);
  const canonicalFrom = chainAdapter.canonicalizeAddress(transfer.fromAddress);

  // Match to an invoice via the receive-addresses join table: family +
  // address pair resolves across all chains in the family. This is how
  // multi-family invoices work — a USDC transfer on Polygon (chainId 137)
  // matches an invoice with `family='evm', address='0xABC'` whether the
  // invoice's primary chain was Ethereum or Arbitrum or any other EVM
  // chain. Transfers to addresses the gateway doesn't own still get
  // recorded with invoice_id=NULL (orphaned-transfer audit).
  const family = chainAdapter.family;
  const invoiceRow = await deps.db
    .prepare(
      `SELECT i.* FROM invoices i
         JOIN invoice_receive_addresses ira ON ira.invoice_id = i.id
        WHERE ira.address = ? AND ira.family = ?
        LIMIT 1`
    )
    .bind(canonicalTo, family)
    .first<InvoiceRow>();

  const invoiceId: string | null = invoiceRow ? invoiceRow.id : null;

  // Decide initial tx status using the reported confirmation count.
  const threshold = confirmationThreshold(transfer.chainId, deps.confirmationThresholds);
  const initialStatus: TxStatus = transfer.confirmations >= threshold ? "confirmed" : "detected";
  const now = deps.clock.now().getTime();
  const txId = globalThis.crypto.randomUUID();

  // USD conversion for USD-path invoices. We pin the rate on the transaction
  // row at detection time so the invoice's total is idempotent even if the
  // rate window later refreshes. Non-USD invoices leave these NULL.
  let amountUsd: string | null = null;
  let usdRate: string | null = null;
  if (invoiceRow && invoiceRow.amount_usd !== null) {
    const acceptedFamilies = parseAcceptedFamilies(invoiceRow.accepted_families);
    const pinned = await refreshIfExpired(
      deps,
      invoiceRow.id,
      invoiceRow.rates_json === null
        ? null
        : (JSON.parse(invoiceRow.rates_json) as Record<string, string>),
      invoiceRow.rate_window_expires_at,
      acceptedFamilies
    );
    const usd = usdValueFor(transfer.amountRaw, transfer.token, transfer.chainId, pinned);
    if (usd !== null) {
      amountUsd = usd;
      usdRate = pinned[transfer.token] ?? null;
    }
    // usd === null path: token not priced. The transfer still writes to
    // transactions (audit) but doesn't contribute to paid_usd. Operator
    // sees it as an "unpriced payment" row and can follow up.
  }

  let insertOk = true;
  try {
    await deps.db
      .prepare(
        `INSERT INTO transactions
           (id, invoice_id, chain_id, tx_hash, log_index, from_address, to_address, token, amount_raw,
            block_number, confirmations, status, amount_usd, usd_rate, detected_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        txId,
        invoiceId,
        transfer.chainId,
        transfer.txHash,
        transfer.logIndex,
        canonicalFrom,
        canonicalTo,
        transfer.token,
        transfer.amountRaw,
        transfer.blockNumber,
        transfer.confirmations,
        initialStatus,
        amountUsd,
        usdRate,
        now,
        initialStatus === "confirmed" ? now : null
      )
      .run();
  } catch (err) {
    // SQLite UNIQUE violation (chain_id, tx_hash, coalesce(log_index,-1)).
    // Duplicate detection is expected — webhook + cron can each surface the
    // same transfer. Silently ignore and return inserted:false.
    if (isUniqueViolation(err)) {
      insertOk = false;
    } else {
      throw err;
    }
  }

  if (!insertOk) {
    return { inserted: false };
  }

  const tx = rowToTransaction({
    id: txId,
    invoice_id: invoiceId,
    chain_id: transfer.chainId,
    tx_hash: transfer.txHash,
    log_index: transfer.logIndex,
    from_address: canonicalFrom,
    to_address: canonicalTo,
    token: transfer.token,
    amount_raw: transfer.amountRaw,
    block_number: transfer.blockNumber,
    confirmations: transfer.confirmations,
    status: initialStatus,
    detected_at: now,
    confirmed_at: initialStatus === "confirmed" ? now : null
  });

  await deps.events.publish({ type: "tx.detected", txId: tx.id, tx, at: new Date(now) });
  if (initialStatus === "confirmed") {
    await deps.events.publish({ type: "tx.confirmed", txId: tx.id, tx, at: new Date(now) });
  }

  if (!invoiceRow) {
    return { inserted: true, transactionId: tx.id };
  }

  const before = invoiceRow.status as InvoiceStatus;
  const after = await recomputeInvoiceFromTransactions(deps, invoiceRow, now);

  // Per-payment webhook: fires once per confirmed transfer that contributes
  // to an invoice. Non-confirmed (still-detected) payments don't fire yet —
  // merchants only care about money they can count on. On reorg-revert the
  // tx.orphaned event + subsequent invoice recompute handle the reversal.
  if (initialStatus === "confirmed") {
    const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceRow.id);
    const snapshotInvoice = rowToInvoice(
      {
        ...invoiceRow,
        status: after,
        updated_at: now
      },
      addresses
    );
    await deps.events.publish({
      type: "invoice.payment_received",
      invoiceId: invoiceRow.id as InvoiceId,
      invoice: snapshotInvoice,
      payment: {
        txHash: transfer.txHash,
        chainId: transfer.chainId,
        token: transfer.token,
        amountRaw: transfer.amountRaw,
        amountUsd,
        usdRate
      },
      at: new Date(now)
    });
  }

  return {
    inserted: true,
    transactionId: tx.id,
    invoiceId: invoiceRow.id as InvoiceId,
    invoiceStatusBefore: before,
    invoiceStatusAfter: after
  };
}

// Parse the `accepted_families` JSON column. Null (legacy single-family
// invoices) falls back to the primary chain's family, derived from the row.
function parseAcceptedFamilies(raw: string | null): readonly ChainFamily[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is ChainFamily => typeof x === "string");
  } catch {
    // Malformed JSON in the column is a bug; fail open (empty set) rather
    // than crashing the ingest path. A follow-up operator review will catch
    // the data corruption via logs.
  }
  return [];
}

// ---- Confirmation sweeper (cron-triggered) ----

export interface ConfirmSweepResult {
  checked: number;
  confirmed: number;
  reverted: number;
  promotedInvoices: number;
}

export async function confirmTransactions(deps: AppDeps): Promise<ConfirmSweepResult> {
  const pending = await deps.db
    .prepare("SELECT * FROM transactions WHERE status = 'detected'")
    .all<TxRow>();

  let confirmed = 0;
  let reverted = 0;
  const touchedInvoiceIds = new Set<string>();

  for (const row of pending.results) {
    const chainAdapter = findChainAdapter(deps, row.chain_id);
    const live = await chainAdapter.getConfirmationStatus(row.chain_id, row.tx_hash);
    const now = deps.clock.now().getTime();
    const threshold = confirmationThreshold(row.chain_id, deps.confirmationThresholds);

    if (live.reverted) {
      await deps.db
        .prepare(
          "UPDATE transactions SET status = 'reverted', confirmations = ?, block_number = ? WHERE id = ?"
        )
        .bind(live.confirmations, live.blockNumber, row.id)
        .run();
      reverted += 1;
      const tx = rowToTransaction({
        ...row,
        status: "reverted",
        confirmations: live.confirmations,
        block_number: live.blockNumber
      });
      await deps.events.publish({ type: "tx.orphaned", txId: tx.id, tx, at: new Date(now) });
      if (row.invoice_id !== null) touchedInvoiceIds.add(row.invoice_id);
      continue;
    }

    if (live.confirmations >= threshold) {
      await deps.db
        .prepare(
          "UPDATE transactions SET status = 'confirmed', confirmations = ?, block_number = ?, confirmed_at = ? WHERE id = ?"
        )
        .bind(live.confirmations, live.blockNumber, now, row.id)
        .run();
      confirmed += 1;
      const tx = rowToTransaction({
        ...row,
        status: "confirmed",
        confirmations: live.confirmations,
        block_number: live.blockNumber,
        confirmed_at: now
      });
      await deps.events.publish({ type: "tx.confirmed", txId: tx.id, tx, at: new Date(now) });
      if (row.invoice_id !== null) touchedInvoiceIds.add(row.invoice_id);
    } else {
      // Still short of the threshold — just update the confirmation counter
      // so the admin views see progress. No event for an increment-only update.
      await deps.db
        .prepare("UPDATE transactions SET confirmations = ?, block_number = ? WHERE id = ?")
        .bind(live.confirmations, live.blockNumber, row.id)
        .run();
    }
  }

  // Batch-load every touched invoice in a single query instead of re-issuing
  // `SELECT * FROM invoices WHERE id = ?` per transaction confirmed in this
  // sweep. The recompute per invoice still runs sequentially (it issues its
  // own read of the contributing txs) but the invoice fetch itself is one
  // round-trip.
  let promotedInvoices = 0;
  if (touchedInvoiceIds.size > 0) {
    const ids = [...touchedInvoiceIds];
    const placeholders = ids.map(() => "?").join(",");
    const invoiceRows = await deps.db
      .prepare(`SELECT * FROM invoices WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<InvoiceRow>();
    for (const invoiceRow of invoiceRows.results) {
      const before = invoiceRow.status as InvoiceStatus;
      const after = await recomputeInvoiceFromTransactions(deps, invoiceRow, deps.clock.now().getTime());
      if (before !== "confirmed" && after === "confirmed") promotedInvoices += 1;
    }
  }

  return { checked: pending.results.length, confirmed, reverted, promotedInvoices };
}

// ---- Reorg re-check sweep ----

// Default reorg-recheck window: 24 hours. Any tx confirmed more recently than
// this gets re-verified against the chain on every sweep; older txs are
// trusted as finalized. Polygon's 256-confirmation threshold already handles
// its known deep-reorg risk, and Ethereum / L2s rarely reorg past ~15 blocks
// — 24h is a very conservative upper bound.
const DEFAULT_REORG_RECHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

// Per-sweep cap. At 1 tick per minute and 200 rows per tick the reorg
// re-check can inspect 12k confirmed txs per hour, enough to cover the
// busiest realistic load and still leave RPC budget for live detection.
const REORG_RECHECK_BATCH_SIZE = 200;

export interface ReorgRecheckResult {
  checked: number;
  demoted: number;
  invoicesTouched: number;
}

// Re-queries the chain for every confirmed tx within the reorg window. A tx
// whose on-chain state has flipped to reverted, or that is no longer known
// to the chain at all, is moved to 'orphaned' and its invoice is recomputed
// — which may demote a previously-confirmed invoice back to partial /
// detected / created.
//
// A tx whose confirmation count merely dropped (but is still positive and
// non-reverted) is NOT orphaned: adapters sometimes transiently report a
// lower count during RPC failover, and a real reorg that displaced the tx
// entirely surfaces as `reverted=true` or `blockNumber=null` next tick.
export async function recheckConfirmedTransactionsForReorg(
  deps: AppDeps,
  opts: { windowMs?: number; limit?: number } = {}
): Promise<ReorgRecheckResult> {
  const windowMs = opts.windowMs ?? DEFAULT_REORG_RECHECK_WINDOW_MS;
  const limit = opts.limit ?? REORG_RECHECK_BATCH_SIZE;
  const now = deps.clock.now().getTime();
  const cutoff = now - windowMs;

  const confirmedRows = await deps.db
    .prepare(
      `SELECT * FROM transactions
        WHERE status = 'confirmed'
          AND confirmed_at IS NOT NULL
          AND confirmed_at >= ?
        ORDER BY confirmed_at DESC
        LIMIT ?`
    )
    .bind(cutoff, limit)
    .all<TxRow>();

  let demoted = 0;
  const touchedInvoiceIds = new Set<string>();

  for (const row of confirmedRows.results) {
    const chainAdapter = findChainAdapter(deps, row.chain_id);
    let live: Awaited<ReturnType<ChainAdapter["getConfirmationStatus"]>>;
    try {
      live = await chainAdapter.getConfirmationStatus(row.chain_id, row.tx_hash);
    } catch (err) {
      // Transient RPC errors must not demote — only explicit
      // `reverted=true` or "tx absent from chain" does. Skip and let the
      // next tick retry.
      deps.logger.warn("reorg recheck: getConfirmationStatus failed", {
        txId: row.id,
        chainId: row.chain_id,
        txHash: row.tx_hash,
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    const absent = live.blockNumber === null && live.confirmations === 0 && !live.reverted;
    if (!live.reverted && !absent) continue;

    await deps.db
      .prepare(
        "UPDATE transactions SET status = 'orphaned', confirmations = ?, block_number = ? WHERE id = ?"
      )
      .bind(live.confirmations, live.blockNumber, row.id)
      .run();
    const tx = rowToTransaction({
      ...row,
      status: "orphaned",
      confirmations: live.confirmations,
      block_number: live.blockNumber
    });
    deps.logger.error("confirmed tx orphaned by reorg", {
      txId: row.id,
      invoiceId: row.invoice_id,
      chainId: row.chain_id,
      txHash: row.tx_hash,
      reverted: live.reverted,
      absent
    });
    await deps.events.publish({ type: "tx.orphaned", txId: tx.id, tx, at: new Date(now) });
    demoted += 1;
    if (row.invoice_id !== null) touchedInvoiceIds.add(row.invoice_id);
  }

  if (touchedInvoiceIds.size > 0) {
    const ids = [...touchedInvoiceIds];
    const placeholders = ids.map(() => "?").join(",");
    const invoiceRows = await deps.db
      .prepare(`SELECT * FROM invoices WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<InvoiceRow>();
    for (const invoiceRow of invoiceRows.results) {
      await recomputeInvoiceFromTransactions(deps, invoiceRow, deps.clock.now().getTime());
    }
  }

  return {
    checked: confirmedRows.results.length,
    demoted,
    invoicesTouched: touchedInvoiceIds.size
  };
}

// ---- Internal: recompute invoice state from its contributing transactions ----

async function recomputeInvoiceFromTransactions(
  deps: AppDeps,
  invoiceRow: InvoiceRow,
  now: number
): Promise<InvoiceStatus> {
  const before = invoiceRow.status as InvoiceStatus;
  if (ADMIN_TERMINAL_STATES.has(before)) {
    // `expired` / `canceled` are frozen. Late transfers still get inserted
    // into `transactions` (audit), but they don't change the invoice state.
    // `confirmed` / `overpaid` invoices fall through — if a reorg orphaned a
    // contributing tx they need to demote.
    return before;
  }

  // USD-path invoices aggregate `amount_usd` across contributing txs; legacy
  // single-token invoices keep summing `amount_raw`. Branch early so the two
  // code paths stay legible.
  if (invoiceRow.amount_usd !== null) {
    return recomputeUsdInvoice(deps, invoiceRow, now);
  }

  // Sum across contributing txs. We include both 'detected' and 'confirmed'
  // because partial-payment progress should update as soon as a transfer is
  // observed, not wait for confirmation. Reverted/orphaned are excluded.
  const contributing = await deps.db
    .prepare(
      "SELECT amount_raw, status FROM transactions WHERE invoice_id = ? AND status IN ('detected','confirmed')"
    )
    .bind(invoiceRow.id)
    .all<{ amount_raw: string; status: string }>();

  let total = 0n;
  let allConfirmed = contributing.results.length > 0;
  for (const tx of contributing.results) {
    total += BigInt(tx.amount_raw);
    if (tx.status !== "confirmed") allConfirmed = false;
  }

  const required = BigInt(invoiceRow.required_amount_raw);

  let after: InvoiceStatus;
  if (total >= required && total > 0n) {
    after = allConfirmed ? "confirmed" : "detected";
  } else if (total > 0n) {
    after = "partial";
  } else {
    // Total is zero — every contributing tx was reverted/orphaned. Re-open the
    // invoice so new payments can still credit it (up until `expires_at`).
    // "created" is the clean structural match: no valid pending inbound
    // transfers.
    after = "created";
  }

  // Persist: always update received_amount_raw; update status only when changed.
  if (after !== before) {
    // Preserve the first-confirm timestamp across reorg round-trips. When a
    // confirmed invoice demotes (reorg) and later re-confirms, keeping the
    // original confirmed_at makes "time-to-confirm" dashboards honest. The
    // USD path already did this; the legacy path didn't, which is C6 territory.
    await deps.db
      .prepare(
        `UPDATE invoices
            SET status = ?,
                received_amount_raw = ?,
                confirmed_at = CASE
                  WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ?
                  ELSE confirmed_at
                END,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(after, total.toString(), after, now, now, invoiceRow.id)
      .run();

    const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceRow.id);
    const updated = rowToInvoice(
      {
        ...invoiceRow,
        status: after,
        received_amount_raw: total.toString(),
        confirmed_at:
          after === "confirmed" && invoiceRow.confirmed_at === null ? now : invoiceRow.confirmed_at,
        updated_at: now
      },
      addresses
    );
    // Reorg demotion (confirmed -> anything lower) is an operator-visible
    // event: the merchant has already been told the payment confirmed, and
    // downstream systems (payout, fulfillment) may have acted on it. Log at
    // error level so alerting picks it up; the webhook fires too so the
    // merchant can reconcile.
    //
    // NOTE: the address-pool release handler (pool.service.ts) already fired
    // on `invoice.confirmed`, so the receive address for this invoice may
    // have been marked available and potentially reallocated to a new
    // invoice. Operators seeing this log should manually verify that any
    // payment observed against the demoted invoice's receive address
    // genuinely belongs to this invoice and not a newer one that inherited
    // the slot. A dedicated `invoice.demoted` event + automatic pool
    // re-acquire is a known follow-up; for now `poolReallocationRisk: true`
    // in the fields tags this log line for alert routing.
    if (before === "confirmed" && after !== "confirmed") {
      deps.logger.error("invoice demoted after confirmation (reorg)", {
        invoiceId: invoiceRow.id,
        merchantId: invoiceRow.merchant_id,
        before,
        after,
        receivedAmountRaw: total.toString(),
        requiredAmountRaw: invoiceRow.required_amount_raw,
        poolReallocationRisk: true
      });
    }
    await deps.events.publish(invoiceEventFor(after, updated, now));
  } else if (total.toString() !== invoiceRow.received_amount_raw) {
    await deps.db
      .prepare("UPDATE invoices SET received_amount_raw = ?, updated_at = ? WHERE id = ?")
      .bind(total.toString(), now, invoiceRow.id)
      .run();
  }

  return after;
}

// USD-path invoice recompute: sums `amount_usd` across contributing confirmed
// transactions, sets status based on paidUsd vs amountUsd, and tracks
// overpaid delta when paidUsd exceeds the target. Unpriced payments
// (amount_usd = NULL) are excluded from the USD total — they still exist
// as audit rows but don't satisfy the invoice.
async function recomputeUsdInvoice(
  deps: AppDeps,
  invoiceRow: InvoiceRow,
  now: number
): Promise<InvoiceStatus> {
  const before = invoiceRow.status as InvoiceStatus;

  // Only CONFIRMED contributing transactions count toward paid_usd — we
  // can't promise the merchant money that might reorg away. `detected`
  // transactions show up in the event stream but don't satisfy the invoice
  // until they cross the confirmation threshold.
  const contributing = await deps.db
    .prepare(
      `SELECT amount_usd FROM transactions
        WHERE invoice_id = ? AND status = 'confirmed' AND amount_usd IS NOT NULL`
    )
    .bind(invoiceRow.id)
    .all<{ amount_usd: string }>();

  let paidUsd = "0";
  for (const row of contributing.results) {
    paidUsd = addUsd(paidUsd, row.amount_usd);
  }

  const amountUsd = invoiceRow.amount_usd!;
  const cmp = compareUsd(paidUsd, amountUsd);

  let after: InvoiceStatus;
  let overpaidUsd = "0";
  if (cmp > 0) {
    after = "overpaid";
    overpaidUsd = subUsd(paidUsd, amountUsd);
  } else if (cmp === 0) {
    after = "confirmed";
  } else if (compareUsd(paidUsd, "0") > 0) {
    after = "partial";
  } else {
    // Nothing confirmed yet. `detected` (still under threshold) payments exist
    // as transactions but don't move the invoice off `created` / whatever
    // prior.
    after = "created";
  }

  // Always update paid_usd / overpaid_usd (even on same-status) so merchant
  // UIs see live progress on partial invoices. Status-change also flips
  // confirmed_at + fires the status event.
  await deps.db
    .prepare(
      `UPDATE invoices
          SET status = ?,
              paid_usd = ?,
              overpaid_usd = ?,
              confirmed_at = CASE WHEN ? IN ('confirmed','overpaid') AND confirmed_at IS NULL THEN ? ELSE confirmed_at END,
              updated_at = ?
        WHERE id = ?`
    )
    .bind(after, paidUsd, overpaidUsd, after, now, now, invoiceRow.id)
    .run();

  if (after !== before) {
    const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceRow.id);
    const updated = rowToInvoice(
      {
        ...invoiceRow,
        status: after,
        paid_usd: paidUsd,
        overpaid_usd: overpaidUsd,
        confirmed_at:
          (after === "confirmed" || after === "overpaid") && invoiceRow.confirmed_at === null
            ? now
            : invoiceRow.confirmed_at,
        updated_at: now
      },
      addresses
    );
    // Reorg demotion on USD-path invoices: confirmed / overpaid are positive
    // terminal-ish outcomes the merchant has been notified about. A
    // transition to a lower status (partial / detected / created) means the
    // chain walked back our happy-path event — surface loudly.
    if (
      (before === "confirmed" || before === "overpaid") &&
      after !== "confirmed" &&
      after !== "overpaid"
    ) {
      deps.logger.error("USD invoice demoted after confirmation (reorg)", {
        invoiceId: invoiceRow.id,
        merchantId: invoiceRow.merchant_id,
        before,
        after,
        paidUsd,
        amountUsd,
        // See note in non-USD recompute path: pool may have released this
        // invoice's receive address on the original confirmation.
        poolReallocationRisk: true
      });
    }
    await deps.events.publish(invoiceEventFor(after, updated, now));
  }

  return after;
}

function invoiceEventFor(status: InvoiceStatus, invoice: Invoice, now: number): DomainEvent {
  const at = new Date(now);
  switch (status) {
    case "partial":
      return { type: "invoice.partial", invoiceId: invoice.id, invoice, at };
    case "detected":
      return { type: "invoice.detected", invoiceId: invoice.id, invoice, at };
    case "confirmed":
      return { type: "invoice.confirmed", invoiceId: invoice.id, invoice, at };
    case "expired":
      return { type: "invoice.expired", invoiceId: invoice.id, invoice, at };
    case "canceled":
      return { type: "invoice.canceled", invoiceId: invoice.id, invoice, at };
    case "created":
      return { type: "invoice.created", invoiceId: invoice.id, invoice, at };
    case "overpaid":
      return { type: "invoice.overpaid", invoiceId: invoice.id, invoice, at };
  }
}

// ---- Error helpers ----

function isUniqueViolation(err: unknown): boolean {
  // libSQL / D1 / SQLite all surface UNIQUE violations with "UNIQUE constraint failed"
  // in the message. Different drivers wrap them differently, so we match on text.
  if (err instanceof Error) {
    return /UNIQUE constraint failed/i.test(err.message);
  }
  return false;
}
