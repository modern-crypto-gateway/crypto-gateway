import { asc, eq } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { DomainEvent } from "../events/event-bus.port.js";
import type { Invoice } from "../types/invoice.js";
import type { Payout } from "../types/payout.js";
import { transactions as transactionsTable } from "../../db/schema.js";
import { chainSlug } from "../types/chain-registry.js";
import { findToken } from "../types/token-registry.js";

// DomainEvent → (merchant-bound webhook payload, idempotency key).
// Returns `null` for events that are internal and not exposed to merchants.
//
// Event-name conventions:
//   - Internal DomainEvent.type uses dots:  invoice.completed
//   - Merchant-facing payload.event uses colons:  invoice:completed
//
// This mapping makes the wire surface visually distinct from the internal
// type names ("which side am I looking at?"), and the colon namespacing
// reads as a hierarchical label rather than a sub-namespace traversal.
//
// Two scopes of events:
//   - invoice:payment_*  — per-transaction (one fires per contributing tx)
//   - invoice:*          — whole-invoice lifecycle (fires once per transition)
//
// Payload is uniformly:
//   { event, timestamp, data: { invoice, transactions, triggerTxHash? } }
// `transactions` always lists every tx ever associated with the invoice
// (status: detected | confirmed | reverted | orphaned) so merchants get a
// complete picture on every event without an extra GET. `triggerTxHash` is
// the tx that caused the event for per-tx events; null for status-only ones.

export interface ComposedWebhook {
  merchantId: string;
  // Resource the event belongs to. Snapshotted onto the delivery row so the
  // retry path knows whether to look up the per-invoice or per-payout webhook
  // override before falling back to the merchant default. Always present —
  // every outbound event we surface relates to one or the other.
  resource: { type: "invoice" | "payout"; id: string };
  payload: WebhookPayload;
  idempotencyKey: string;
}

export interface WebhookPayload {
  event: WebhookEventName;
  timestamp: string; // ISO-8601
  data: Record<string, unknown>;
}

// Merchant-facing event names. Colon-separated; the leading prefix is the
// resource ("invoice" | "payout") and the suffix is the lifecycle action.
// `payment_*` is a sub-prefix on invoice events that distinguishes per-tx
// signals from whole-invoice lifecycle signals.
export type WebhookEventName =
  | "invoice:payment_detected"
  | "invoice:payment_confirmed"
  | "invoice:processing"
  | "invoice:completed"
  | "invoice:expired"
  | "invoice:canceled"
  | "invoice:demoted"
  | "payout.submitted"
  | "payout.confirmed"
  | "payout.failed";

// Pure: takes the event plus pre-loaded transactions and returns the wire
// payload. The DB read for transactions happens in the subscriber so this
// function stays free of side effects and trivially unit-testable.
//
// `transactions` should be the full set of txs ever associated with the
// invoice (status: detected | confirmed | reverted | orphaned). Callers that
// don't have an invoice context (payout events) pass [].
export function composeWebhook(
  event: DomainEvent,
  transactions: readonly TransactionPayload[] = []
): ComposedWebhook | null {
  switch (event.type) {
    case "invoice.completed":
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: "invoice:completed",
          timestamp: event.at.toISOString(),
          data: invoiceEnvelope(event.invoice, transactions, null)
        },
        // Status is part of the key so a same-invoice transition that lands
        // again at `completed` after a reorg-then-reconfirm produces a fresh
        // delivery row instead of being deduped against the prior one.
        idempotencyKey: `invoice:completed:${event.invoice.id}:${event.invoice.status}`
      };

    case "invoice.expired":
    case "invoice.canceled": {
      const wireEvent: WebhookEventName =
        event.type === "invoice.expired" ? "invoice:expired" : "invoice:canceled";
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: wireEvent,
          timestamp: event.at.toISOString(),
          data: invoiceEnvelope(event.invoice, transactions, null)
        },
        idempotencyKey: `${wireEvent}:${event.invoice.id}:${event.invoice.status}`
      };
    }

    case "invoice.processing": {
      // Idempotency key encodes status + extra_status so each distinct
      // processing flavor delivers exactly once. Examples:
      //   - pending → processing (full amount detected, awaiting conf):
      //     key = invoice:processing:<id>:processing:none
      //   - pending → processing(partial):
      //     key = invoice:processing:<id>:processing:partial
      //   - processing(partial) → processing (extra cleared after a top-up):
      //     key = invoice:processing:<id>:processing:none — distinct from
      //     the partial delivery above, so the merchant sees the upgrade.
      // A reorg cycle (processing → completed → processing) reuses the
      // earlier key — that's the dedup contract; reorg specifically uses
      // `invoice:demoted` for the merchant signal.
      const extraSlug = event.invoice.extraStatus ?? "none";
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: "invoice:processing",
          timestamp: event.at.toISOString(),
          data: invoiceEnvelope(event.invoice, transactions, null)
        },
        idempotencyKey: `invoice:processing:${event.invoice.id}:${event.invoice.status}:${extraSlug}`
      };
    }

    case "invoice.demoted": {
      // Reorg un-confirmation. Keyed by (invoiceId, previousStatus, newStatus)
      // so distinct reorg events from the same invoice aren't deduped.
      const envelope = invoiceEnvelope(event.invoice, transactions, null);
      // demoted carries reorg-specific extras alongside the standard envelope.
      envelope.previousStatus = event.previousStatus;
      envelope.poolReacquired = event.poolReacquired;
      envelope.poolCollided = event.poolCollided;
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: "invoice:demoted",
          timestamp: event.at.toISOString(),
          data: envelope
        },
        idempotencyKey: `invoice:demoted:${event.invoice.id}:${event.previousStatus}:${event.invoice.status}`
      };
    }

    case "invoice.payment_detected":
    case "invoice.payment_confirmed": {
      // Per-transfer audit events. Keyed on (invoice id + tx hash + event
      // name) — same hash detected then later confirmed produces TWO distinct
      // webhook rows (one per event name) instead of colliding.
      const wireEvent: WebhookEventName =
        event.type === "invoice.payment_detected"
          ? "invoice:payment_detected"
          : "invoice:payment_confirmed";
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: wireEvent,
          timestamp: event.at.toISOString(),
          data: invoiceEnvelope(event.invoice, transactions, event.payment.txHash)
        },
        idempotencyKey: `${wireEvent}:${event.invoice.id}:${event.payment.txHash}`
      };
    }

    case "payout.submitted":
    case "payout.confirmed":
    case "payout.failed":
      return {
        merchantId: event.payout.merchantId,
        resource: { type: "payout", id: event.payout.id },
        payload: {
          event: event.type,
          timestamp: event.at.toISOString(),
          data: serializePayout(event.payout)
        },
        idempotencyKey: `${event.type}:${event.payout.id}:${event.payout.status}`
      };

    // Internal events — don't expose to merchants.
    case "invoice.created":
    case "tx.detected":
    case "tx.confirmed":
    case "tx.orphaned":
    case "payout.planned":
    case "pool.address.created":
    case "pool.address.quarantined":
      return null;
  }
}

// Single shared shape for every invoice-event payload's `data` block. The
// caller can tack on event-specific extras (e.g. `previousStatus` for
// demoted) as additional properties on the returned object.
function invoiceEnvelope(
  invoice: Invoice,
  txs: readonly TransactionPayload[],
  triggerTxHash: string | null
): Record<string, unknown> {
  return {
    invoice: serializeInvoice(invoice),
    transactions: txs,
    triggerTxHash
  };
}

export interface TransactionPayload {
  hash: string;
  chainId: number;
  chainName: string | null;
  token: string;
  isNative: boolean;
  // Human-decimal form (amountRaw / 10^decimals), formatted as a string to
  // preserve precision. `null` when we can't resolve the token's decimals
  // (e.g. a transfer recorded against a token that was later removed from
  // the registry).
  amount: string | null;
  amountRaw: string;
  amountUsd: string | null;
  confirmations: number;
  status: "detected" | "confirmed" | "reverted" | "orphaned";
}

// Loads every transaction associated with an invoice, ordered by detection
// time. Returns an empty array for invoices with no contributing txs (e.g.
// `pending` or `expired` with no payment activity). Called by the subscriber
// for invoice events; payout events skip the call.
export async function loadInvoiceTransactions(
  deps: AppDeps,
  invoiceId: string
): Promise<readonly TransactionPayload[]> {
  const rows = await deps.db
    .select({
      txHash: transactionsTable.txHash,
      chainId: transactionsTable.chainId,
      token: transactionsTable.token,
      amountRaw: transactionsTable.amountRaw,
      amountUsd: transactionsTable.amountUsd,
      confirmations: transactionsTable.confirmations,
      status: transactionsTable.status,
      detectedAt: transactionsTable.detectedAt
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.invoiceId, invoiceId))
    .orderBy(asc(transactionsTable.detectedAt));

  return rows.map((row) => {
    const tokenInfo = findToken(row.chainId as never, row.token as never);
    const isNative = tokenInfo !== null && tokenInfo.contractAddress === null;
    const amount = tokenInfo === null ? null : formatAmount(row.amountRaw, tokenInfo.decimals);
    return {
      hash: row.txHash,
      chainId: row.chainId,
      chainName: chainSlug(row.chainId as never),
      token: row.token,
      isNative,
      amount,
      amountRaw: row.amountRaw,
      amountUsd: row.amountUsd,
      confirmations: row.confirmations,
      status: row.status as TransactionPayload["status"]
    };
  });
}

// `amountRaw` (base units) → human decimal string. Pure integer math —
// avoids floating-point precision loss for 18-decimal tokens at large
// amounts. e.g. ("1500000", 6) → "1.5", ("12345678901234567890", 18) →
// "12.34567890123456789".
function formatAmount(amountRaw: string, decimals: number): string {
  if (decimals === 0) return amountRaw;
  const negative = amountRaw.startsWith("-");
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  if (digits === "0") return "0";
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const formatted = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return negative ? `-${formatted}` : formatted;
}

function serializeInvoice(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
    status: invoice.status,
    extraStatus: invoice.extraStatus,
    chainId: invoice.chainId,
    token: invoice.token,
    receiveAddress: invoice.receiveAddress,
    addressIndex: invoice.addressIndex,
    acceptedFamilies: invoice.acceptedFamilies,
    receiveAddresses: invoice.receiveAddresses.map((r) => ({
      family: r.family,
      address: r.address
    })),
    // Legacy single-token amounts. Populated for non-USD invoices; "0" /
    // null on USD-pegged invoices where amount lives in `amountUsd` /
    // `paidUsd` / `overpaidUsd` below.
    requiredAmountRaw: invoice.requiredAmountRaw,
    receivedAmountRaw: invoice.receivedAmountRaw,
    fiatAmount: invoice.fiatAmount,
    fiatCurrency: invoice.fiatCurrency,
    quotedRate: invoice.quotedRate,
    // USD-path amounts. amountUsd is the target the merchant set; paidUsd is
    // the running confirmed total; overpaidUsd is the excess once the target
    // is exceeded. All three are decimal strings to preserve precision.
    amountUsd: invoice.amountUsd,
    paidUsd: invoice.paidUsd,
    overpaidUsd: invoice.overpaidUsd,
    // Pinned rate snapshot for the current window. Useful for partial /
    // detected events so the merchant can show the customer "X token left to
    // pay" without re-pricing on their side. Both null on legacy invoices.
    rateWindowExpiresAt:
      invoice.rateWindowExpiresAt === null ? null : invoice.rateWindowExpiresAt.toISOString(),
    rates: invoice.rates,
    paymentToleranceUnderBps: invoice.paymentToleranceUnderBps,
    paymentToleranceOverBps: invoice.paymentToleranceOverBps,
    externalId: invoice.externalId,
    metadata: invoice.metadata,
    createdAt: invoice.createdAt.toISOString(),
    expiresAt: invoice.expiresAt.toISOString(),
    confirmedAt: invoice.confirmedAt === null ? null : invoice.confirmedAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString()
  };
}

function serializePayout(payout: Payout): Record<string, unknown> {
  return {
    id: payout.id,
    kind: payout.kind,
    parentPayoutId: payout.parentPayoutId,
    status: payout.status,
    chainId: payout.chainId,
    token: payout.token,
    amountRaw: payout.amountRaw,
    feeTier: payout.feeTier,
    feeQuotedNative: payout.feeQuotedNative,
    batchId: payout.batchId,
    destinationAddress: payout.destinationAddress,
    sourceAddress: payout.sourceAddress,
    txHash: payout.txHash,
    topUpTxHash: payout.topUpTxHash,
    topUpSponsorAddress: payout.topUpSponsorAddress,
    lastError: payout.lastError,
    submittedAt: payout.submittedAt === null ? null : payout.submittedAt.toISOString(),
    confirmedAt: payout.confirmedAt === null ? null : payout.confirmedAt.toISOString()
  };
}

// Exported for unit-test access — the formatter is pure and worth pinning.
export { formatAmount as __formatAmountForTest };
