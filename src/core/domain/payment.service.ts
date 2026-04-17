import type { AppDeps } from "../app-deps.js";
import type { DomainEvent } from "../events/event-bus.port.js";
import type { ChainFamily } from "../types/chain.js";
import type { Order, OrderId, OrderStatus } from "../types/order.js";
import { DetectedTransferSchema, type TransactionId, type TxStatus } from "../types/transaction.js";
import { findChainAdapter } from "./chain-lookup.js";
import {
  fetchOrderReceiveAddresses,
  rowToOrder,
  rowToTransaction,
  type OrderRow,
  type TxRow
} from "./mappers.js";
import { confirmationThreshold } from "./payment-config.js";
import { addUsd, compareUsd, refreshIfExpired, subUsd, usdValueFor } from "./rate-window.js";

// PaymentService: rules for how detected transfers become transactions, how
// transactions accumulate into orders, and how confirmation counts promote
// through the state machine. Chain-agnostic — every family calls into the same
// logic via the ChainAdapter port.

// Terminal states: once an order lands here, no further transfers update it.
const ORDER_TERMINAL_STATES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(["confirmed", "expired", "canceled"]);

// ---- Ingest a detected transfer ----

export interface IngestResult {
  inserted: boolean;
  transactionId?: TransactionId;
  orderId?: OrderId;
  orderStatusBefore?: OrderStatus;
  orderStatusAfter?: OrderStatus;
}

export async function ingestDetectedTransfer(deps: AppDeps, input: unknown): Promise<IngestResult> {
  const transfer = DetectedTransferSchema.parse(input);

  const chainAdapter = findChainAdapter(deps, transfer.chainId);
  const canonicalTo = chainAdapter.canonicalizeAddress(transfer.toAddress);
  const canonicalFrom = chainAdapter.canonicalizeAddress(transfer.fromAddress);

  // Match to an order via the receive-addresses join table: family +
  // address pair resolves across all chains in the family. This is how
  // multi-family orders work — a USDC transfer on Polygon (chainId 137)
  // matches an order with `family='evm', address='0xABC'` whether the
  // order's primary chain was Ethereum or Arbitrum or any other EVM chain.
  // Transfers to addresses the gateway doesn't own still get recorded
  // with order_id=NULL (orphaned-transfer audit).
  const family = chainAdapter.family;
  const orderRow = await deps.db
    .prepare(
      `SELECT o.* FROM orders o
         JOIN order_receive_addresses ora ON ora.order_id = o.id
        WHERE ora.address = ? AND ora.family = ?
        LIMIT 1`
    )
    .bind(canonicalTo, family)
    .first<OrderRow>();

  const orderId: string | null = orderRow ? orderRow.id : null;

  // Decide initial tx status using the reported confirmation count.
  const threshold = confirmationThreshold(transfer.chainId);
  const initialStatus: TxStatus = transfer.confirmations >= threshold ? "confirmed" : "detected";
  const now = deps.clock.now().getTime();
  const txId = globalThis.crypto.randomUUID();

  // USD conversion for USD-path orders. We pin the rate on the transaction
  // row at detection time so the order's total is idempotent even if the
  // rate window later refreshes. Non-USD orders leave these NULL.
  let amountUsd: string | null = null;
  let usdRate: string | null = null;
  if (orderRow && orderRow.amount_usd !== null) {
    const acceptedFamilies = parseAcceptedFamilies(orderRow.accepted_families);
    const pinned = await refreshIfExpired(
      deps,
      orderRow.id,
      orderRow.rates_json === null
        ? null
        : (JSON.parse(orderRow.rates_json) as Record<string, string>),
      orderRow.rate_window_expires_at,
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
           (id, order_id, chain_id, tx_hash, log_index, from_address, to_address, token, amount_raw,
            block_number, confirmations, status, amount_usd, usd_rate, detected_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        txId,
        orderId,
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
    order_id: orderId,
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

  if (!orderRow) {
    return { inserted: true, transactionId: tx.id };
  }

  const before = orderRow.status as OrderStatus;
  const after = await recomputeOrderFromTransactions(deps, orderRow, now);

  // Per-payment webhook (A2.b): fires once per confirmed transfer that
  // contributes to an order. Non-confirmed (still-detected) payments don't
  // fire yet — merchants only care about money they can count on. On
  // reorg-revert the tx.orphaned event + subsequent order recompute handle
  // the reversal.
  if (initialStatus === "confirmed") {
    const addresses = await fetchOrderReceiveAddresses(deps, orderRow.id);
    const snapshotOrder = rowToOrder(
      {
        ...orderRow,
        status: after,
        updated_at: now
      },
      addresses
    );
    await deps.events.publish({
      type: "order.payment_received",
      orderId: orderRow.id as OrderId,
      order: snapshotOrder,
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
    orderId: orderRow.id as OrderId,
    orderStatusBefore: before,
    orderStatusAfter: after
  };
}

// Parse the `accepted_families` JSON column. Null (legacy single-family
// orders) falls back to the primary chain's family, derived from the row.
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
  promotedOrders: number;
}

export async function confirmTransactions(deps: AppDeps): Promise<ConfirmSweepResult> {
  const pending = await deps.db
    .prepare("SELECT * FROM transactions WHERE status = 'detected'")
    .all<TxRow>();

  let confirmed = 0;
  let reverted = 0;
  const touchedOrderIds = new Set<string>();

  for (const row of pending.results) {
    const chainAdapter = findChainAdapter(deps, row.chain_id);
    const live = await chainAdapter.getConfirmationStatus(row.chain_id, row.tx_hash);
    const now = deps.clock.now().getTime();
    const threshold = confirmationThreshold(row.chain_id);

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
      if (row.order_id !== null) touchedOrderIds.add(row.order_id);
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
      if (row.order_id !== null) touchedOrderIds.add(row.order_id);
    } else {
      // Still short of the threshold — just update the confirmation counter
      // so the admin views see progress. No event for an increment-only update.
      await deps.db
        .prepare("UPDATE transactions SET confirmations = ?, block_number = ? WHERE id = ?")
        .bind(live.confirmations, live.blockNumber, row.id)
        .run();
    }
  }

  let promotedOrders = 0;
  for (const orderId of touchedOrderIds) {
    const orderRow = await deps.db
      .prepare("SELECT * FROM orders WHERE id = ?")
      .bind(orderId)
      .first<OrderRow>();
    if (!orderRow) continue;
    const before = orderRow.status as OrderStatus;
    const after = await recomputeOrderFromTransactions(deps, orderRow, deps.clock.now().getTime());
    if (before !== "confirmed" && after === "confirmed") promotedOrders += 1;
  }

  return { checked: pending.results.length, confirmed, reverted, promotedOrders };
}

// ---- Internal: recompute order state from its contributing transactions ----

async function recomputeOrderFromTransactions(
  deps: AppDeps,
  orderRow: OrderRow,
  now: number
): Promise<OrderStatus> {
  const before = orderRow.status as OrderStatus;
  if (ORDER_TERMINAL_STATES.has(before)) {
    // Terminal orders are frozen. Late transfers still get inserted into
    // `transactions` (audit), but they don't change the order state.
    return before;
  }

  // USD-path orders aggregate `amount_usd` across contributing txs; legacy
  // single-token orders keep summing `amount_raw`. Branch early so the two
  // code paths stay legible.
  if (orderRow.amount_usd !== null) {
    return recomputeUsdOrder(deps, orderRow, now);
  }

  // Sum across contributing txs. We include both 'detected' and 'confirmed'
  // because partial-payment progress should update as soon as a transfer is
  // observed, not wait for confirmation. Reverted/orphaned are excluded.
  const contributing = await deps.db
    .prepare(
      "SELECT amount_raw, status FROM transactions WHERE order_id = ? AND status IN ('detected','confirmed')"
    )
    .bind(orderRow.id)
    .all<{ amount_raw: string; status: string }>();

  let total = 0n;
  let allConfirmed = contributing.results.length > 0;
  for (const tx of contributing.results) {
    total += BigInt(tx.amount_raw);
    if (tx.status !== "confirmed") allConfirmed = false;
  }

  const required = BigInt(orderRow.required_amount_raw);

  let after: OrderStatus;
  if (total >= required && total > 0n) {
    after = allConfirmed ? "confirmed" : "detected";
  } else if (total > 0n) {
    after = "partial";
  } else {
    // Total is zero — every contributing tx was reverted/orphaned. Re-open the
    // order so new payments can still credit it (up until `expires_at`). "created"
    // is the clean structural match: no valid pending inbound transfers.
    after = "created";
  }

  // Persist: always update received_amount_raw; update status only when changed.
  if (after !== before) {
    await deps.db
      .prepare(
        `UPDATE orders
            SET status = ?,
                received_amount_raw = ?,
                confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(after, total.toString(), after, now, now, orderRow.id)
      .run();

    const addresses = await fetchOrderReceiveAddresses(deps, orderRow.id);
    const updated = rowToOrder(
      {
        ...orderRow,
        status: after,
        received_amount_raw: total.toString(),
        confirmed_at: after === "confirmed" ? now : orderRow.confirmed_at,
        updated_at: now
      },
      addresses
    );
    await deps.events.publish(orderEventFor(after, updated, now));
  } else if (total.toString() !== orderRow.received_amount_raw) {
    await deps.db
      .prepare("UPDATE orders SET received_amount_raw = ?, updated_at = ? WHERE id = ?")
      .bind(total.toString(), now, orderRow.id)
      .run();
  }

  return after;
}

// USD-path order recompute: sums `amount_usd` across contributing confirmed
// transactions, sets status based on paidUsd vs amountUsd, and tracks
// overpaid delta when paidUsd exceeds the target. Unpriced payments
// (amount_usd = NULL) are excluded from the USD total — they still exist
// as audit rows but don't satisfy the invoice.
async function recomputeUsdOrder(
  deps: AppDeps,
  orderRow: OrderRow,
  now: number
): Promise<OrderStatus> {
  const before = orderRow.status as OrderStatus;

  // Only CONFIRMED contributing transactions count toward paid_usd — we
  // can't promise the merchant money that might reorg away. `detected`
  // transactions show up in the event stream but don't satisfy the order
  // until they cross the confirmation threshold.
  const contributing = await deps.db
    .prepare(
      `SELECT amount_usd FROM transactions
        WHERE order_id = ? AND status = 'confirmed' AND amount_usd IS NOT NULL`
    )
    .bind(orderRow.id)
    .all<{ amount_usd: string }>();

  let paidUsd = "0";
  for (const row of contributing.results) {
    paidUsd = addUsd(paidUsd, row.amount_usd);
  }

  const amountUsd = orderRow.amount_usd!;
  const cmp = compareUsd(paidUsd, amountUsd);

  let after: OrderStatus;
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
    // as transactions but don't move the order off `created` / whatever prior.
    after = "created";
  }

  // Always update paid_usd / overpaid_usd (even on same-status) so merchant
  // UIs see live progress on partial invoices. Status-change also flips
  // confirmed_at + fires the status event.
  await deps.db
    .prepare(
      `UPDATE orders
          SET status = ?,
              paid_usd = ?,
              overpaid_usd = ?,
              confirmed_at = CASE WHEN ? IN ('confirmed','overpaid') AND confirmed_at IS NULL THEN ? ELSE confirmed_at END,
              updated_at = ?
        WHERE id = ?`
    )
    .bind(after, paidUsd, overpaidUsd, after, now, now, orderRow.id)
    .run();

  if (after !== before) {
    const addresses = await fetchOrderReceiveAddresses(deps, orderRow.id);
    const updated = rowToOrder(
      {
        ...orderRow,
        status: after,
        paid_usd: paidUsd,
        overpaid_usd: overpaidUsd,
        confirmed_at:
          (after === "confirmed" || after === "overpaid") && orderRow.confirmed_at === null
            ? now
            : orderRow.confirmed_at,
        updated_at: now
      },
      addresses
    );
    await deps.events.publish(orderEventFor(after, updated, now));
  }

  return after;
}

function orderEventFor(status: OrderStatus, order: Order, now: number): DomainEvent {
  const at = new Date(now);
  switch (status) {
    case "partial":
      return { type: "order.partial", orderId: order.id, order, at };
    case "detected":
      return { type: "order.detected", orderId: order.id, order, at };
    case "confirmed":
      return { type: "order.confirmed", orderId: order.id, order, at };
    case "expired":
      return { type: "order.expired", orderId: order.id, order, at };
    case "canceled":
      return { type: "order.canceled", orderId: order.id, order, at };
    case "created":
      return { type: "order.created", orderId: order.id, order, at };
    case "overpaid":
      return { type: "order.overpaid", orderId: order.id, order, at };
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
