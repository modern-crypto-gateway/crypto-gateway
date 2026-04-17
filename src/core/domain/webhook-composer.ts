import type { DomainEvent } from "../events/event-bus.port.js";
import type { Order } from "../types/order.js";
import type { Payout } from "../types/payout.js";

// Pure function: DomainEvent -> (merchant-bound webhook payload, idempotency key).
// Returns `null` for events that are internal and not exposed to merchants
// (e.g. tx.detected fires during polling and isn't merchant-visible; we only
// surface order- and payout-level state changes).
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
  | "order.partial"
  | "order.detected"
  | "order.confirmed"
  | "order.expired"
  | "order.canceled"
  | "payout.submitted"
  | "payout.confirmed"
  | "payout.failed";

export function composeWebhook(event: DomainEvent): ComposedWebhook | null {
  switch (event.type) {
    case "order.partial":
    case "order.detected":
    case "order.confirmed":
    case "order.expired":
    case "order.canceled":
      return {
        merchantId: event.order.merchantId,
        payload: {
          event: event.type,
          timestamp: event.at.toISOString(),
          data: serializeOrder(event.order)
        },
        idempotencyKey: `${event.type}:${event.order.id}:${event.order.status}`
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
    case "order.created":
    case "tx.detected":
    case "tx.confirmed":
    case "tx.orphaned":
    case "payout.planned":
    case "pool.address.created":
    case "pool.address.quarantined":
      return null;
  }
}

function serializeOrder(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    status: order.status,
    chainId: order.chainId,
    token: order.token,
    receiveAddress: order.receiveAddress,
    acceptedFamilies: order.acceptedFamilies,
    receiveAddresses: order.receiveAddresses.map((r) => ({
      family: r.family,
      address: r.address
    })),
    requiredAmountRaw: order.requiredAmountRaw,
    receivedAmountRaw: order.receivedAmountRaw,
    fiatAmount: order.fiatAmount,
    fiatCurrency: order.fiatCurrency,
    externalId: order.externalId,
    metadata: order.metadata,
    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
    confirmedAt: order.confirmedAt === null ? null : order.confirmedAt.toISOString()
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
