import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { DomainEvent } from "../events/event-bus.port.js";
import type { ChainFamily } from "../types/chain.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import type { Invoice, InvoiceId, InvoiceStatus } from "../types/invoice.js";
import { DetectedTransferSchema, type TransactionId, type TxStatus } from "../types/transaction.js";
import { findChainAdapter } from "./chain-lookup.js";
import { isUniqueViolation } from "./db-errors.js";
import {
  drizzleRowToInvoice,
  drizzleRowToTransaction,
  fetchInvoiceReceiveAddresses
} from "./mappers.js";
import { confirmationThreshold } from "./payment-config.js";
import { reacquireForInvoice } from "./pool.service.js";
import { addUsd, applyBps, compareUsd, refreshIfExpired, subUsd, usdValueFor } from "./rate-window.js";
import { addressPool, invoices, invoiceReceiveAddresses, payouts, transactions } from "../../db/schema.js";

type InvoiceRow = typeof invoices.$inferSelect;

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
  // chain.
  //
  // Ordering rationale: an address can have been tied to multiple invoices
  // across time (pool reuse). Prefer the currently-active invoice (created /
  // partial / detected); if none, prefer the most-recent terminal one so
  // cooldown-bounded late-payment attribution lands on the right merchant.
  // A terminal match only stands when the pool row is still in cooldown —
  // past that, we treat the transfer as an orphan (invoiceId=NULL,
  // status='orphaned') so it doesn't auto-credit an expired invoice whose
  // merchant may no longer own the address.
  const family = chainAdapter.family;
  const candidates = await deps.db
    .select({ invoice: invoices })
    .from(invoices)
    .innerJoin(invoiceReceiveAddresses, eq(invoiceReceiveAddresses.invoiceId, invoices.id))
    .where(and(eq(invoiceReceiveAddresses.address, canonicalTo), eq(invoiceReceiveAddresses.family, family)))
    .orderBy(
      // Non-terminal invoices first. SQLite has no boolean sort so we materialize
      // a CASE expression and ASC-sort it.
      sql`CASE WHEN ${invoices.status} IN ('created','partial','detected','confirmed','overpaid') THEN 0 ELSE 1 END`,
      desc(invoices.createdAt)
    )
    .limit(1);
  const topCandidate: InvoiceRow | null = candidates[0] ? candidates[0].invoice : null;

  // Cooldown-aware attribution: if the top candidate is a terminal invoice
  // (expired / canceled), we only credit it when the pool row for this
  // address is still inside its cooldown window. Otherwise the transfer
  // records as an orphan for admin reconciliation.
  let invoiceRow: InvoiceRow | null = topCandidate;
  if (topCandidate !== null && ADMIN_TERMINAL_STATES.has(topCandidate.status as InvoiceStatus)) {
    const inCooldown = await isAddressInCooldown(deps, family, canonicalTo);
    if (!inCooldown) invoiceRow = null;
  }

  const invoiceId: string | null = invoiceRow ? invoiceRow.id : null;
  // Orphaned transfers land with invoice_id NULL and status='orphaned' so
  // the admin queue (via idx_transactions_orphans_open) surfaces them for
  // attribution or dismissal. Matched transfers follow the normal
  // detected → confirmed lifecycle.
  const isOrphanRow = invoiceRow === null;

  // Outbound-payout dedupe. Alchemy ADDRESS_ACTIVITY webhooks (and our
  // RPC poller) fire on EVERY transfer touching a watched address — so
  // when the gateway broadcasts a payout FROM a pool address, the same
  // tx surfaces here as a "detected transfer" whose `to_address` is the
  // merchant's destination. There's no invoice that wants to receive at
  // the merchant's destination address, so without this guard the row
  // lands as an orphan. The orphan row contributes 0 to spendable
  // (computeSpendable only sums `confirmed`) — but it's noise in the
  // admin orphan queue and dilutes the signal of real unattributed
  // inbound payments.
  //
  // Authoritative source for this tx already exists in the `payouts`
  // table (kind='standard' or 'gas_top_up' with txHash set). When the
  // detected tx_hash matches a known payout, skip the insert entirely:
  // the payout's existing row is the canonical record, and `failPayout`'s
  // gas_burn debit + `confirmPayouts`' value debit handle the ledger.
  if (isOrphanRow) {
    const [matchingPayout] = await deps.db
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(
          eq(payouts.txHash, transfer.txHash),
          eq(payouts.chainId, transfer.chainId)
        )
      )
      .limit(1);
    if (matchingPayout) {
      deps.logger.debug("ingest.skip.payout_self_detect", {
        chainId: transfer.chainId,
        txHash: transfer.txHash,
        payoutId: matchingPayout.id
      });
      return { inserted: false };
    }
  }

  // Decide initial tx status using the reported confirmation count. Orphaned
  // transfers (no invoice match under cooldown rules) bypass the detected →
  // confirmed track entirely and land as 'orphaned' for admin attribution.
  const threshold = confirmationThreshold(transfer.chainId, deps.confirmationThresholds);
  const initialStatus: TxStatus = isOrphanRow
    ? "orphaned"
    : (transfer.confirmations >= threshold ? "confirmed" : "detected");
  const now = deps.clock.now().getTime();
  const txId = globalThis.crypto.randomUUID();

  // USD conversion for USD-path invoices. We pin the rate on the transaction
  // row at detection time so the invoice's total is idempotent even if the
  // rate window later refreshes. Non-USD invoices leave these NULL.
  let amountUsd: string | null = null;
  let usdRate: string | null = null;
  if (invoiceRow && invoiceRow.amountUsd !== null) {
    const acceptedFamilies = parseAcceptedFamilies(invoiceRow.acceptedFamilies);
    const pinned = await refreshIfExpired(
      deps,
      invoiceRow.id,
      invoiceRow.ratesJson === null
        ? null
        : (JSON.parse(invoiceRow.ratesJson) as Record<string, string>),
      invoiceRow.rateWindowExpiresAt,
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
  } else if (isOrphanRow) {
    // Best-effort USD valuation for orphans so the admin reconciliation
    // queue shows "$12.34 of USDT came in" instead of a blank $0.00 row.
    // One oracle call per orphan; failure is silently ignored (NULL falls
    // back to pre-change behavior). Doesn't contribute to any invoice —
    // just decorates the row for the admin UI + later forensic lookups.
    try {
      const rates = await deps.priceOracle.getUsdRates([transfer.token]);
      const rate = rates[transfer.token];
      if (rate !== undefined) {
        const usd = usdValueFor(transfer.amountRaw, transfer.token, transfer.chainId, rates);
        if (usd !== null) {
          amountUsd = usd;
          usdRate = rate;
        }
      }
    } catch {
      // Oracle outage must not block ingest. Orphan row still writes with
      // NULL USD fields; a future `/admin/attribute-orphan` will compute
      // USD against the target invoice's rates.
    }
  }

  const txInsert: typeof transactions.$inferInsert = {
    id: txId,
    invoiceId,
    chainId: transfer.chainId,
    txHash: transfer.txHash,
    logIndex: transfer.logIndex,
    fromAddress: canonicalFrom,
    toAddress: canonicalTo,
    token: transfer.token,
    amountRaw: transfer.amountRaw,
    blockNumber: transfer.blockNumber,
    confirmations: transfer.confirmations,
    status: initialStatus,
    amountUsd,
    usdRate,
    detectedAt: now,
    confirmedAt: initialStatus === "confirmed" ? now : null
  };
  let insertOk = true;
  try {
    await deps.db.insert(transactions).values(txInsert);
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

  const tx = drizzleRowToTransaction(txInsert as typeof transactions.$inferSelect);

  // Orphans are admin-private: no tx.detected / tx.confirmed fan-out, no
  // invoice-level webhooks. The row is written (with invoice_id=NULL and
  // status='orphaned') so the admin queue can surface it for attribution or
  // dismissal; until then, no merchant signal fires.
  if (!isOrphanRow) {
    await deps.events.publish({ type: "tx.detected", txId: tx.id, tx, at: new Date(now) });
    if (initialStatus === "confirmed") {
      await deps.events.publish({ type: "tx.confirmed", txId: tx.id, tx, at: new Date(now) });
    }
  }

  if (!invoiceRow) {
    return { inserted: true, transactionId: tx.id };
  }

  const before = invoiceRow.status as InvoiceStatus;
  const after = await recomputeInvoiceFromTransactions(deps, invoiceRow, now);

  // Per-transfer webhooks. Two flavors so merchants can drive both
  // "incoming, awaiting confirmations" UX and "money in the bank" UX:
  //   - invoice.transfer_detected — fires the first time a transfer is
  //     observed against an invoice, while it's still in `detected`
  //     (pre-confirmation). Carries `confirmations` so the merchant can
  //     show progress.
  //   - invoice.payment_received — fires once per CONFIRMED transfer
  //     that contributes to an invoice. This is the audit-grade signal:
  //     the chain has crossed the threshold and the money is durable.
  // On reorg-revert the tx.orphaned event + subsequent invoice recompute
  // handle the reversal of a previously-confirmed transfer.
  const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceRow.id);
  const snapshotInvoice = drizzleRowToInvoice(
    {
      ...invoiceRow,
      status: after,
      updatedAt: now
    },
    addresses
  );
  if (initialStatus === "detected") {
    await deps.events.publish({
      type: "invoice.transfer_detected",
      invoiceId: invoiceRow.id as InvoiceId,
      invoice: snapshotInvoice,
      payment: {
        txHash: transfer.txHash,
        chainId: transfer.chainId,
        token: transfer.token,
        amountRaw: transfer.amountRaw,
        amountUsd,
        usdRate,
        confirmations: transfer.confirmations
      },
      at: new Date(now)
    });
  }
  if (initialStatus === "confirmed") {
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

// True iff the pool row for (family, address) is still in its cooldown
// window. Used by the ingest matcher to decide whether a transfer should
// credit a recently-terminal invoice (cooldown active) or land as an orphan
// (cooldown elapsed / no pool row). Absence of a pool row (e.g. fee wallets,
// externally-owned addresses) returns false — those aren't owned by the
// cooldown lifecycle.
async function isAddressInCooldown(
  deps: AppDeps,
  family: ChainFamily,
  address: string
): Promise<boolean> {
  const now = deps.clock.now().getTime();
  const [row] = await deps.db
    .select({ cooldownUntil: addressPool.cooldownUntil })
    .from(addressPool)
    .where(and(eq(addressPool.family, family), eq(addressPool.address, address)))
    .limit(1);
  if (!row) return false;
  if (row.cooldownUntil === null) return false;
  return row.cooldownUntil > now;
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

export interface ConfirmTransactionsOptions {
  // Caps the rows fetched per tick. On Workers the whole runScheduledJobs
  // call shares a 30s CPU budget, so sweeps that each dispatch an RPC per
  // row must bound their batch or risk killing the entire tick mid-flight.
  // The cron runs frequently enough that partial progress is fine — the
  // remainder gets picked up next tick. Default 200 leaves ~150ms/row at 30s.
  maxBatch?: number;
}

export async function confirmTransactions(
  deps: AppDeps,
  opts: ConfirmTransactionsOptions = {}
): Promise<ConfirmSweepResult> {
  const limit = opts.maxBatch ?? 200;
  // Pick up two flavors of in-progress rows:
  //   - status='detected' — the primary path, detected→confirmed promotion.
  //   - status='orphaned' AND confirmed_at IS NULL — orphan enrichment.
  //     Orphans bypass the detected→confirmed track at ingest time (they
  //     have no invoice to promote for), so their blockNumber +
  //     confirmations + confirmed_at would otherwise stay at whatever the
  //     detector emitted. This branch runs getConfirmationStatus on each
  //     and fills those fields in so the admin queue + forensic lookups
  //     have a full picture of the tx. Status stays 'orphaned'; no events.
  const pending = await deps.db
    .select()
    .from(transactions)
    .where(
      or(
        eq(transactions.status, "detected"),
        and(eq(transactions.status, "orphaned"), isNull(transactions.confirmedAt))
      )!
    )
    .orderBy(asc(transactions.detectedAt))
    .limit(limit);

  let confirmed = 0;
  let reverted = 0;
  const touchedInvoiceIds = new Set<string>();
  // Rows we promoted detected→confirmed in this sweep — used after the
  // per-invoice recompute below to fire the per-transfer "money confirmed"
  // webhook for poll-only chains. Push-ingest already fires this from
  // ingestDetectedTransfer; the cron-promoted path is the missing twin.
  const promotedTxRows: typeof pending = [];

  for (const row of pending) {
    const chainAdapter = findChainAdapter(deps, row.chainId);
    const live = await chainAdapter.getConfirmationStatus(row.chainId, row.txHash);
    const now = deps.clock.now().getTime();
    const threshold = confirmationThreshold(row.chainId, deps.confirmationThresholds);
    // Orphan rows are admin-private: they get the same block/confs
    // enrichment pass but skip merchant-facing events and invoice
    // recomputes. The query above already restricts orphan rows to those
    // with confirmedAt IS NULL so we don't re-enrich enriched orphans.
    const isOrphanRow = row.status === "orphaned";

    if (live.reverted) {
      await deps.db
        .update(transactions)
        .set({ status: "reverted", confirmations: live.confirmations, blockNumber: live.blockNumber })
        .where(eq(transactions.id, row.id));
      reverted += 1;
      const tx = drizzleRowToTransaction({
        ...row,
        status: "reverted",
        confirmations: live.confirmations,
        blockNumber: live.blockNumber
      });
      // Orphans are admin-private: skip event + touched-invoice bookkeeping.
      // The already-NULL invoiceId would no-op anyway, but the event is
      // merchant-visible on a subscriber and has no meaning for orphans.
      if (!isOrphanRow) {
        await deps.events.publish({ type: "tx.orphaned", txId: tx.id, tx, at: new Date(now) });
        if (row.invoiceId !== null) touchedInvoiceIds.add(row.invoiceId);
      }
      continue;
    }

    if (live.confirmations >= threshold) {
      // Orphans stay orphaned — we only backfill confirmedAt/block/confs so
      // the admin queue shows "this is finalized, here's when and where".
      const newStatus = isOrphanRow ? ("orphaned" as const) : ("confirmed" as const);
      await deps.db
        .update(transactions)
        .set({
          status: newStatus,
          confirmations: live.confirmations,
          blockNumber: live.blockNumber,
          confirmedAt: now
        })
        .where(eq(transactions.id, row.id));
      if (!isOrphanRow) {
        confirmed += 1;
        const tx = drizzleRowToTransaction({
          ...row,
          status: "confirmed",
          confirmations: live.confirmations,
          blockNumber: live.blockNumber,
          confirmedAt: now
        });
        await deps.events.publish({ type: "tx.confirmed", txId: tx.id, tx, at: new Date(now) });
        if (row.invoiceId !== null) {
          touchedInvoiceIds.add(row.invoiceId);
          promotedTxRows.push(row);
        }
      }
    } else {
      // Still short of the threshold — just update the confirmation counter
      // (and blockNumber for initial null-block enrichment) so the admin
      // views see progress. No event for an increment-only update. Same
      // shape for matched rows and orphans.
      await deps.db
        .update(transactions)
        .set({ confirmations: live.confirmations, blockNumber: live.blockNumber })
        .where(eq(transactions.id, row.id));
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
    const invoiceRows = await deps.db
      .select()
      .from(invoices)
      .where(inArray(invoices.id, ids));
    const invoicesById = new Map(invoiceRows.map((r) => [r.id, r] as const));
    for (const invoiceRow of invoiceRows) {
      const before = invoiceRow.status as InvoiceStatus;
      const after = await recomputeInvoiceFromTransactions(deps, invoiceRow, deps.clock.now().getTime());
      if (before !== "confirmed" && after === "confirmed") promotedInvoices += 1;
    }
    // Per-transfer "transfer confirmed" webhook for the polled path. Push-
    // ingest already fires `invoice.payment_received` from ingestDetectedTransfer
    // when a transfer arrives confirmed; this is the cron-promoted twin so
    // merchants on poll-only chains see the same per-payment audit signal.
    for (const promotedRow of promotedTxRows) {
      if (promotedRow.invoiceId === null) continue;
      const invoiceRow = invoicesById.get(promotedRow.invoiceId);
      if (!invoiceRow) continue;
      const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceRow.id);
      const snapshotInvoice = drizzleRowToInvoice(invoiceRow, addresses);
      await deps.events.publish({
        type: "invoice.payment_received",
        invoiceId: invoiceRow.id as InvoiceId,
        invoice: snapshotInvoice,
        payment: {
          txHash: promotedRow.txHash,
          chainId: promotedRow.chainId,
          token: promotedRow.token,
          amountRaw: promotedRow.amountRaw,
          amountUsd: promotedRow.amountUsd,
          usdRate: promotedRow.usdRate
        },
        at: new Date(deps.clock.now().getTime())
      });
    }
  }

  return { checked: pending.length, confirmed, reverted, promotedInvoices };
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

// Throttle interval for recheckConfirmedTransactionsForReorg. The cron fires
// every minute but a tx that was confirmed yesterday does not need to be
// re-verified that often — a 10-minute cadence is still well inside any
// realistic reorg-detection window (Ethereum finalizes in ~13 min,
// Polygon's 256-block threshold finalizes in ~9 min) while cutting RPC
// spend by 10x on confirmed-tx rechecks. Override via opts.intervalMs (set
// to 0 in tests to disable throttling).
const DEFAULT_REORG_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
const REORG_RECHECK_THROTTLE_CACHE_KEY = "reorg-recheck:last-run";

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
  opts: { windowMs?: number; limit?: number; intervalMs?: number } = {}
): Promise<ReorgRecheckResult> {
  const windowMs = opts.windowMs ?? DEFAULT_REORG_RECHECK_WINDOW_MS;
  const limit = opts.limit ?? REORG_RECHECK_BATCH_SIZE;
  const intervalMs = opts.intervalMs ?? DEFAULT_REORG_RECHECK_INTERVAL_MS;

  // Throttle: at the 1-min cron cadence we do not need to re-verify
  // every confirmed tx every tick. A presence-only cache key with TTL =
  // intervalMs gates execution; a missing key (cold cache or TTL expired)
  // means "go", and we re-set the key. KV's eventual consistency may let
  // two ticks both see "missing" inside a small window — that's fine, the
  // recheck is idempotent.
  if (intervalMs > 0) {
    const last = await deps.cache.get(REORG_RECHECK_THROTTLE_CACHE_KEY);
    if (last !== null) {
      return { checked: 0, demoted: 0, invoicesTouched: 0 };
    }
    await deps.cache.put(REORG_RECHECK_THROTTLE_CACHE_KEY, "1", {
      ttlSeconds: Math.max(60, Math.floor(intervalMs / 1000))
    });
  }

  const now = deps.clock.now().getTime();
  const cutoff = now - windowMs;

  const confirmedRows = await deps.db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "confirmed"),
        isNotNull(transactions.confirmedAt),
        gte(transactions.confirmedAt, cutoff)
      )
    )
    .orderBy(desc(transactions.confirmedAt))
    .limit(limit);

  let demoted = 0;
  const touchedInvoiceIds = new Set<string>();

  for (const row of confirmedRows) {
    const chainAdapter = findChainAdapter(deps, row.chainId);
    let live: Awaited<ReturnType<ChainAdapter["getConfirmationStatus"]>>;
    try {
      live = await chainAdapter.getConfirmationStatus(row.chainId, row.txHash);
    } catch (err) {
      // Transient RPC errors must not demote — only explicit
      // `reverted=true` or "tx absent from chain" does. Skip and let the
      // next tick retry.
      deps.logger.warn("reorg recheck: getConfirmationStatus failed", {
        txId: row.id,
        chainId: row.chainId,
        txHash: row.txHash,
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    const absent = live.blockNumber === null && live.confirmations === 0 && !live.reverted;
    if (!live.reverted && !absent) continue;

    await deps.db
      .update(transactions)
      .set({ status: "orphaned", confirmations: live.confirmations, blockNumber: live.blockNumber })
      .where(eq(transactions.id, row.id));
    const tx = drizzleRowToTransaction({
      ...row,
      status: "orphaned",
      confirmations: live.confirmations,
      blockNumber: live.blockNumber
    });
    deps.logger.error("confirmed tx orphaned by reorg", {
      txId: row.id,
      invoiceId: row.invoiceId,
      chainId: row.chainId,
      txHash: row.txHash,
      reverted: live.reverted,
      absent
    });
    await deps.events.publish({ type: "tx.orphaned", txId: tx.id, tx, at: new Date(now) });
    demoted += 1;
    if (row.invoiceId !== null) touchedInvoiceIds.add(row.invoiceId);
  }

  if (touchedInvoiceIds.size > 0) {
    const ids = [...touchedInvoiceIds];
    const invoiceRows = await deps.db
      .select()
      .from(invoices)
      .where(inArray(invoices.id, ids));
    for (const invoiceRow of invoiceRows) {
      await recomputeInvoiceFromTransactions(deps, invoiceRow, deps.clock.now().getTime());
    }
  }

  return {
    checked: confirmedRows.length,
    demoted,
    invoicesTouched: touchedInvoiceIds.size
  };
}

// ---- Internal: recompute invoice state from its contributing transactions ----

export interface RecomputeOptions {
  // Admin-driven override: when true, the recompute is allowed to leave the
  // ADMIN_TERMINAL_STATES set (expired / canceled) IF the contributing txs
  // total clears the invoice's confirm bar (with bps tolerance). Partial
  // credits against a terminal invoice are refused — the invoice stays
  // expired / canceled. Called from the admin "attribute orphan" route
  // after it re-points a transaction row at the target invoice.
  viaAdminOverride?: boolean;
}

export async function recomputeInvoiceFromTransactions(
  deps: AppDeps,
  invoiceRow: InvoiceRow,
  now: number,
  options: RecomputeOptions = {}
): Promise<InvoiceStatus> {
  const before = invoiceRow.status as InvoiceStatus;
  if (ADMIN_TERMINAL_STATES.has(before) && !options.viaAdminOverride) {
    // `expired` / `canceled` are frozen. Late transfers still get inserted
    // into `transactions` (audit), but they don't change the invoice state.
    // `confirmed` / `overpaid` invoices fall through — if a reorg orphaned a
    // contributing tx they need to demote.
    return before;
  }

  // USD-path invoices aggregate `amount_usd` across contributing txs; legacy
  // single-token invoices keep summing `amount_raw`. Branch early so the two
  // code paths stay legible.
  if (invoiceRow.amountUsd !== null) {
    return recomputeUsdInvoice(deps, invoiceRow, now, options);
  }

  // Sum across contributing txs. We include both 'detected' and 'confirmed'
  // because partial-payment progress should update as soon as a transfer is
  // observed, not wait for confirmation. Reverted/orphaned are excluded.
  //
  // Token filter is critical: with native tokens (ETH/POL/BNB/AVAX/TRX) now
  // first-class in the registry, an Alchemy webhook can push e.g. an ETH
  // transfer at the receive address of a USDC invoice. The amounts are in
  // incomparable units (1 wei vs 1 micro-USDC); summing them blindly would
  // wrongly confirm the invoice. The wrong-token tx still gets recorded
  // (linked to the invoice for audit) but doesn't credit toward the total.
  // The USD-path recompute doesn't need this filter — it sums `amount_usd`
  // which normalizes across tokens.
  const contributing = await deps.db
    .select({ amountRaw: transactions.amountRaw, status: transactions.status })
    .from(transactions)
    .where(
      and(
        eq(transactions.invoiceId, invoiceRow.id),
        eq(transactions.token, invoiceRow.token),
        inArray(transactions.status, ["detected", "confirmed"])
      )
    );

  let total = 0n;
  let allConfirmed = contributing.length > 0;
  for (const tx of contributing) {
    total += BigInt(tx.amountRaw);
    if (tx.status !== "confirmed") allConfirmed = false;
  }

  const required = BigInt(invoiceRow.requiredAmountRaw);

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

  // Admin override against a terminal invoice: only full-amount credits can
  // lift the invoice out of expired / canceled. Partial credits stay parked
  // — the merchant's decision to expire/cancel stands when the payment
  // doesn't clear the bar.
  if (
    options.viaAdminOverride &&
    ADMIN_TERMINAL_STATES.has(before) &&
    after !== "confirmed"
  ) {
    after = before;
  }

  // Persist: always update received_amount_raw; update status only when changed.
  if (after !== before) {
    // Preserve the first-confirm timestamp across reorg round-trips. When a
    // confirmed invoice demotes (reorg) and later re-confirms, keeping the
    // original confirmed_at makes "time-to-confirm" dashboards honest. The
    // USD path already did this; the legacy path didn't, which is C6 territory.
    const nextConfirmedAt =
      after === "confirmed" && invoiceRow.confirmedAt === null ? now : invoiceRow.confirmedAt;
    await deps.db
      .update(invoices)
      .set({
        status: after,
        receivedAmountRaw: total.toString(),
        confirmedAt: nextConfirmedAt,
        updatedAt: now
      })
      .where(eq(invoices.id, invoiceRow.id));

    const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceRow.id);
    const updated = drizzleRowToInvoice(
      {
        ...invoiceRow,
        status: after,
        receivedAmountRaw: total.toString(),
        confirmedAt: nextConfirmedAt,
        updatedAt: now
      },
      addresses
    );
    // Reorg demotion (confirmed -> anything lower) is an operator-visible
    // event: the merchant has already been told the payment confirmed, and
    // downstream systems (payout, fulfillment) may have acted on it.
    //
    // Two things happen, in order:
    //   1. Try to re-claim the pool addresses this invoice used. They were
    //      released on `invoice.confirmed`; a newer invoice may have taken
    //      the slot. `reacquireForInvoice` reports the outcome so we log
    //      (and publish) whether any collision happened.
    //   2. Publish `invoice.demoted` BEFORE the normal status-transition
    //      event so subscribers see the reorg flag first.
    if (before === "confirmed" && after !== "confirmed") {
      let poolReacquired = 0;
      let poolCollided = 0;
      try {
        const outcome = await reacquireForInvoice(
          deps,
          invoiceRow.id,
          addresses.map((a) => a.address)
        );
        poolReacquired = outcome.reacquired;
        poolCollided = outcome.collided;
      } catch (err) {
        deps.logger.error("pool re-acquire failed on demotion", {
          invoiceId: invoiceRow.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      deps.logger.error("invoice demoted after confirmation (reorg)", {
        invoiceId: invoiceRow.id,
        merchantId: invoiceRow.merchantId,
        before,
        after,
        receivedAmountRaw: total.toString(),
        requiredAmountRaw: invoiceRow.requiredAmountRaw,
        poolReacquired,
        poolCollided,
        poolReallocationRisk: poolCollided > 0
      });
      await deps.events.publish({
        type: "invoice.demoted",
        invoiceId: updated.id,
        invoice: updated,
        previousStatus: before,
        poolReacquired,
        poolCollided,
        at: new Date(now)
      });
    }
    await deps.events.publish(invoiceEventFor(after, updated, now));
  } else if (total.toString() !== invoiceRow.receivedAmountRaw) {
    await deps.db
      .update(invoices)
      .set({ receivedAmountRaw: total.toString(), updatedAt: now })
      .where(eq(invoices.id, invoiceRow.id));
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
  now: number,
  options: RecomputeOptions = {}
): Promise<InvoiceStatus> {
  const before = invoiceRow.status as InvoiceStatus;

  // Only CONFIRMED contributing transactions count toward paid_usd — we
  // can't promise the merchant money that might reorg away. `detected`
  // transactions show up in the event stream but don't satisfy the invoice
  // until they cross the confirmation threshold.
  const contributing = await deps.db
    .select({ amountUsd: transactions.amountUsd })
    .from(transactions)
    .where(
      and(
        eq(transactions.invoiceId, invoiceRow.id),
        eq(transactions.status, "confirmed"),
        isNotNull(transactions.amountUsd)
      )
    );

  let paidUsd = "0";
  for (const row of contributing) {
    paidUsd = addUsd(paidUsd, row.amountUsd!);
  }

  const amountUsd = invoiceRow.amountUsd!;
  // Per-invoice tolerance bands. Snapshotted at create time so the merchant
  // changing their default mid-flight doesn't retroactively close partials.
  //   confirmThreshold = amountUsd × (1 − under/10_000)  — paid_usd at-or-above this closes confirmed
  //   overpaidThreshold = amountUsd × (1 + over /10_000) — paid_usd above this closes overpaid
  // overpaidUsd remains the *raw* delta (paid − amount) so merchant accounting
  // still sees the true overshoot regardless of where the threshold sits.
  const confirmThreshold = applyBps(amountUsd, invoiceRow.paymentToleranceUnderBps, "down");
  const overpaidThreshold = applyBps(amountUsd, invoiceRow.paymentToleranceOverBps, "up");

  let after: InvoiceStatus;
  let overpaidUsd = "0";
  if (compareUsd(paidUsd, overpaidThreshold) > 0) {
    after = "overpaid";
    overpaidUsd = subUsd(paidUsd, amountUsd);
  } else if (compareUsd(paidUsd, confirmThreshold) >= 0 && compareUsd(paidUsd, "0") > 0) {
    after = "confirmed";
  } else if (compareUsd(paidUsd, "0") > 0) {
    after = "partial";
  } else {
    // Nothing confirmed yet. `detected` (still under threshold) payments exist
    // as transactions but don't move the invoice off `created` / whatever
    // prior.
    after = "created";
  }

  // Admin override against a terminal invoice: only credits that clear the
  // confirm bar (confirmed or overpaid) flip the invoice out of expired /
  // canceled. `partial` / `created` leave the merchant's prior decision in
  // place.
  if (
    options.viaAdminOverride &&
    ADMIN_TERMINAL_STATES.has(before) &&
    after !== "confirmed" &&
    after !== "overpaid"
  ) {
    after = before;
  }

  // Always update paid_usd / overpaid_usd (even on same-status) so merchant
  // UIs see live progress on partial invoices. Status-change also flips
  // confirmed_at + fires the status event.
  const nextConfirmedAt =
    (after === "confirmed" || after === "overpaid") && invoiceRow.confirmedAt === null
      ? now
      : invoiceRow.confirmedAt;
  await deps.db
    .update(invoices)
    .set({
      status: after,
      paidUsd,
      overpaidUsd,
      confirmedAt: nextConfirmedAt,
      updatedAt: now
    })
    .where(eq(invoices.id, invoiceRow.id));

  if (after !== before) {
    const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceRow.id);
    const updated = drizzleRowToInvoice(
      {
        ...invoiceRow,
        status: after,
        paidUsd,
        overpaidUsd,
        confirmedAt: nextConfirmedAt,
        updatedAt: now
      },
      addresses
    );
    // Reorg demotion on USD-path invoices: confirmed / overpaid are positive
    // terminal-ish outcomes the merchant has been notified about. A
    // transition to a lower status (partial / detected / created) means the
    // chain walked back our happy-path event. Same re-acquire + demoted-
    // event flow as the non-USD path.
    if (
      (before === "confirmed" || before === "overpaid") &&
      after !== "confirmed" &&
      after !== "overpaid"
    ) {
      let poolReacquired = 0;
      let poolCollided = 0;
      try {
        const outcome = await reacquireForInvoice(
          deps,
          invoiceRow.id,
          addresses.map((a) => a.address)
        );
        poolReacquired = outcome.reacquired;
        poolCollided = outcome.collided;
      } catch (err) {
        deps.logger.error("pool re-acquire failed on demotion", {
          invoiceId: invoiceRow.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      deps.logger.error("USD invoice demoted after confirmation (reorg)", {
        invoiceId: invoiceRow.id,
        merchantId: invoiceRow.merchantId,
        before,
        after,
        paidUsd,
        amountUsd,
        poolReacquired,
        poolCollided,
        poolReallocationRisk: poolCollided > 0
      });
      await deps.events.publish({
        type: "invoice.demoted",
        invoiceId: updated.id,
        invoice: updated,
        previousStatus: before,
        poolReacquired,
        poolCollided,
        at: new Date(now)
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

// ---- Recovery: relink orphan transactions ----

// Background: prior to the address-canonicalization fix, EVM addresses were
// stored EIP-55 mixed-case in `transactions.to_address` but lowercase in
// `invoice_receive_addresses.address`. SQLite's case-sensitive TEXT compare
// silently dropped the JOIN in `ingestDetectedTransfer`, leaving the row
// with `invoice_id = NULL`. This function walks every still-orphan tx, runs
// the same `family + canonicalAddress` lookup the live ingest path uses,
// links the matches, and recomputes touched invoices so downstream
// merchant webhooks fire.

export interface RelinkOrphansOptions {
  // Default false: report what would change without writing. Pass `apply: true`
  // to commit the linkage and trigger invoice recompute + webhook events.
  apply?: boolean;
  // Cap rows scanned per call. Recovery scripts can iterate; default is generous
  // (10k) since the work per row is one cheap address join.
  limit?: number;
}

export interface RelinkOrphansResult {
  apply: boolean;
  candidatesScanned: number;
  linked: number;
  invoicesTouched: number;
  invoicesPromoted: number;
  skipped: Array<{ txId: string; chainId: number; toAddress: string; reason: string }>;
  // Up to 20 sample (txId -> invoiceId) mappings for operator audit.
  samples: Array<{ txId: string; chainId: number; toAddress: string; invoiceId: string; status: TxStatus }>;
}

export async function relinkOrphanTransactions(
  deps: AppDeps,
  opts: RelinkOrphansOptions = {}
): Promise<RelinkOrphansResult> {
  const apply = opts.apply ?? false;
  const limit = opts.limit ?? 10_000;
  const now = deps.clock.now().getTime();

  const orphans = await deps.db
    .select()
    .from(transactions)
    .where(
      and(
        isNull(transactions.invoiceId),
        // Reverted / orphaned rows are end-state — re-linking them would just
        // confuse the audit trail. Recover only live (detected) and confirmed
        // payments that should have credited an invoice.
        inArray(transactions.status, ["detected", "confirmed"])
      )
    )
    .limit(limit);

  const skipped: RelinkOrphansResult["skipped"] = [];
  const samples: RelinkOrphansResult["samples"] = [];
  const touchedInvoiceIds = new Set<string>();
  let linked = 0;

  for (const row of orphans) {
    let chainAdapter: ChainAdapter;
    try {
      chainAdapter = findChainAdapter(deps, row.chainId);
    } catch {
      skipped.push({ txId: row.id, chainId: row.chainId, toAddress: row.toAddress, reason: "no chain adapter" });
      continue;
    }

    let canonicalTo: string;
    let canonicalFrom: string;
    try {
      canonicalTo = chainAdapter.canonicalizeAddress(row.toAddress);
      canonicalFrom = chainAdapter.canonicalizeAddress(row.fromAddress);
    } catch (err) {
      skipped.push({
        txId: row.id,
        chainId: row.chainId,
        toAddress: row.toAddress,
        reason: `canonicalize failed: ${err instanceof Error ? err.message : String(err)}`
      });
      continue;
    }

    const family = chainAdapter.family;
    const [matched] = await deps.db
      .select({ invoice: invoices })
      .from(invoices)
      .innerJoin(invoiceReceiveAddresses, eq(invoiceReceiveAddresses.invoiceId, invoices.id))
      .where(and(eq(invoiceReceiveAddresses.address, canonicalTo), eq(invoiceReceiveAddresses.family, family)))
      .limit(1);

    if (!matched) {
      skipped.push({ txId: row.id, chainId: row.chainId, toAddress: row.toAddress, reason: "no invoice for address" });
      continue;
    }

    if (apply) {
      // Lowercase the stored addresses while we're here — same canonicalization
      // the post-fix ingest path applies, so future joins (and the recompute
      // below, when it filters by invoice_id, doesn't need it but still) use
      // the same case the rest of the system uses.
      await deps.db
        .update(transactions)
        .set({ invoiceId: matched.invoice.id, toAddress: canonicalTo, fromAddress: canonicalFrom })
        .where(eq(transactions.id, row.id));

      // Per-payment webhook for confirmed orphans, mirroring the live ingest
      // path (only confirmed transfers fire `invoice.payment_received`).
      if (row.status === "confirmed") {
        const addresses = await fetchInvoiceReceiveAddresses(deps, matched.invoice.id);
        const snapshotInvoice = drizzleRowToInvoice(matched.invoice, addresses);
        await deps.events.publish({
          type: "invoice.payment_received",
          invoiceId: matched.invoice.id as InvoiceId,
          invoice: snapshotInvoice,
          payment: {
            txHash: row.txHash,
            chainId: row.chainId,
            token: row.token,
            amountRaw: row.amountRaw,
            amountUsd: row.amountUsd,
            usdRate: row.usdRate
          },
          at: new Date(now)
        });
      }

      touchedInvoiceIds.add(matched.invoice.id);
    }

    linked += 1;
    if (samples.length < 20) {
      samples.push({
        txId: row.id,
        chainId: row.chainId,
        toAddress: canonicalTo,
        invoiceId: matched.invoice.id,
        status: row.status as TxStatus
      });
    }
  }

  // Recompute every touched invoice. The recompute itself fires the
  // status-transition events (invoice.confirmed / .partial / etc.) so
  // merchants see both the per-payment ping and the invoice lifecycle event.
  let invoicesPromoted = 0;
  if (apply && touchedInvoiceIds.size > 0) {
    const ids = [...touchedInvoiceIds];
    const invoiceRows = await deps.db.select().from(invoices).where(inArray(invoices.id, ids));
    for (const invoiceRow of invoiceRows) {
      const before = invoiceRow.status as InvoiceStatus;
      const after = await recomputeInvoiceFromTransactions(deps, invoiceRow, now);
      if (before !== "confirmed" && after === "confirmed") invoicesPromoted += 1;
    }
  }

  return {
    apply,
    candidatesScanned: orphans.length,
    linked,
    invoicesTouched: touchedInvoiceIds.size,
    invoicesPromoted,
    skipped,
    samples
  };
}

