import type { DomainEvent } from "../events/event-bus.port.js";
import type { Invoice } from "../types/invoice.js";
import type { Payout } from "../types/payout.js";

// Pure function: DomainEvent -> (merchant-bound webhook payload, idempotency key).
// Returns `null` for events that are internal and not exposed to merchants
// (e.g. tx.detected fires during polling and isn't merchant-visible; we only
// surface invoice- and payout-level state changes).
//
// Rules:
//   - payload.event:   kebab-case event name merchants see on the wire
//   - payload.data:    minimal, JSON-safe entity snapshot
//   - idempotencyKey:  stable per (event type, entity id, target status) so a
//                      dispatcher retry never delivers twice to a well-behaved merchant
//
// The composer does NOT look up the merchant or dispatch. It is a leaf function
// for easy unit testing and to keep the event bus subscriber thin.

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

export type WebhookEventName =
  | "invoice.partial"
  | "invoice.detected"
  | "invoice.confirmed"
  | "invoice.overpaid"
  | "invoice.expired"
  | "invoice.canceled"
  | "invoice.demoted"
  | "invoice.transfer_detected"
  | "invoice.payment_received"
  | "payout.submitted"
  | "payout.confirmed"
  | "payout.failed";

export function composeWebhook(event: DomainEvent): ComposedWebhook | null {
  switch (event.type) {
    case "invoice.partial":
    case "invoice.detected":
    case "invoice.confirmed":
    case "invoice.overpaid":
    case "invoice.expired":
    case "invoice.canceled":
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: event.type,
          timestamp: event.at.toISOString(),
          data: serializeInvoice(event.invoice)
        },
        idempotencyKey: `${event.type}:${event.invoice.id}:${event.invoice.status}`
      };

    case "invoice.demoted":
      // Reorg un-confirmation. Keyed by (invoiceId, previousStatus, newStatus)
      // so distinct reorg events from the same invoice are not deduped. Pool
      // re-acquire counts travel alongside the invoice body so merchants
      // can surface "address potentially reused by invoice X" alerts if
      // `poolCollided > 0`.
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: event.type,
          timestamp: event.at.toISOString(),
          data: {
            invoice: serializeInvoice(event.invoice),
            previousStatus: event.previousStatus,
            poolReacquired: event.poolReacquired,
            poolCollided: event.poolCollided
          }
        },
        idempotencyKey: `${event.type}:${event.invoice.id}:${event.previousStatus}:${event.invoice.status}`
      };

    case "invoice.payment_received":
    case "invoice.transfer_detected":
      // Per-transfer audit events. transfer_detected fires once per first-seen
      // unconfirmed transfer; payment_received fires once per confirmed
      // transfer. Both key idempotency on txHash so merchants de-dup retries
      // — the event TYPE is part of the key, so a transfer that's first
      // detected and later confirmed produces TWO distinct webhook rows
      // (one per type) instead of colliding.
      return {
        merchantId: event.invoice.merchantId,
        resource: { type: "invoice", id: event.invoice.id },
        payload: {
          event: event.type,
          timestamp: event.at.toISOString(),
          data: {
            invoice: serializeInvoice(event.invoice),
            payment: event.payment
          }
        },
        idempotencyKey: `${event.type}:${event.invoice.id}:${event.payment.txHash}`
      };

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

function serializeInvoice(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
    status: invoice.status,
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
