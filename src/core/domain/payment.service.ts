import type { AppDeps } from "../app-deps.js";
import type { DomainEvent } from "../events/event-bus.port.js";
import type { Order, OrderId, OrderStatus } from "../types/order.js";
import { DetectedTransferSchema, type TransactionId, type TxStatus } from "../types/transaction.js";
import { findChainAdapter } from "./chain-lookup.js";
import { rowToOrder, rowToTransaction, type OrderRow, type TxRow } from "./mappers.js";
import { confirmationThreshold } from "./payment-config.js";

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

  // Match to an order by (chain_id, receive_address). Transfers to addresses
  // the gateway doesn't own still get recorded with order_id=NULL for later
  // reconciliation (v1 rule — orphaned-transfer audit trail is load-bearing
  // when operators investigate "customer paid, didn't get credit" tickets).
  const orderRow = await deps.db
    .prepare("SELECT * FROM orders WHERE chain_id = ? AND receive_address = ?")
    .bind(transfer.chainId, canonicalTo)
    .first<OrderRow>();

  const orderId: string | null = orderRow ? orderRow.id : null;

  // Decide initial tx status using the reported confirmation count.
  const threshold = confirmationThreshold(transfer.chainId);
  const initialStatus: TxStatus = transfer.confirmations >= threshold ? "confirmed" : "detected";
  const now = deps.clock.now().getTime();
  const txId = globalThis.crypto.randomUUID();

  let insertOk = true;
  try {
    await deps.db
      .prepare(
        `INSERT INTO transactions
           (id, order_id, chain_id, tx_hash, log_index, from_address, to_address, token, amount_raw,
            block_number, confirmations, status, detected_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  return {
    inserted: true,
    transactionId: tx.id,
    orderId: orderRow.id as OrderId,
    orderStatusBefore: before,
    orderStatusAfter: after
  };
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

    const updated = rowToOrder({
      ...orderRow,
      status: after,
      received_amount_raw: total.toString(),
      confirmed_at: after === "confirmed" ? now : orderRow.confirmed_at,
      updated_at: now
    });
    await deps.events.publish(orderEventFor(after, updated, now));
  } else if (total.toString() !== orderRow.received_amount_raw) {
    await deps.db
      .prepare("UPDATE orders SET received_amount_raw = ?, updated_at = ? WHERE id = ?")
      .bind(total.toString(), now, orderRow.id)
      .run();
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
