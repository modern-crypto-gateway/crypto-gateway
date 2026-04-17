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
        payload: {
          event: event.type,
          timestamp: event.at.toISOString(),
          data: serializeInvoice(event.invoice)
        },
        idempotencyKey: `${event.type}:${event.invoice.id}:${event.invoice.status}`
      };

    case "invoice.payment_received":
      // Per-payment audit event. Idempotency keys on txHash so merchants
      // de-duplicate retries across redelivery.
      return {
        merchantId: event.invoice.merchantId,
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
    acceptedFamilies: invoice.acceptedFamilies,
    receiveAddresses: invoice.receiveAddresses.map((r) => ({
      family: r.family,
      address: r.address
    })),
    requiredAmountRaw: invoice.requiredAmountRaw,
    receivedAmountRaw: invoice.receivedAmountRaw,
    fiatAmount: invoice.fiatAmount,
    fiatCurrency: invoice.fiatCurrency,
    externalId: invoice.externalId,
    metadata: invoice.metadata,
    createdAt: invoice.createdAt.toISOString(),
    expiresAt: invoice.expiresAt.toISOString(),
    confirmedAt: invoice.confirmedAt === null ? null : invoice.confirmedAt.toISOString()
  };
}

function serializePayout(payout: Payout): Record<string, unknown> {
  return {
    id: payout.id,
    status: payout.status,
    chainId: payout.chainId,
    token: payout.token,
    amountRaw: payout.amountRaw,
    destinationAddress: payout.destinationAddress,
    sourceAddress: payout.sourceAddress,
    txHash: payout.txHash,
    lastError: payout.lastError,
    submittedAt: payout.submittedAt === null ? null : payout.submittedAt.toISOString(),
    confirmedAt: payout.confirmedAt === null ? null : payout.confirmedAt.toISOString()
  };
}
