import type { ChainFamily } from "../types/chain.js";
import type { Invoice, InvoiceId } from "../types/invoice.js";
import type { Payout, PayoutId } from "../types/payout.js";
import type { Transaction, TransactionId } from "../types/transaction.js";

// Domain events. Every state transition in invoice/tx/payout emits exactly one
// event. Subscribers (webhook composer, reconciliation, audit log) react
// without the emitting service having to know about them — so adding a new
// reaction does not touch the state machine.
//
// Event shapes are intentionally flat JSON-safe objects, not references, so a
// future queue-backed EventBus (CF Queues / Redis Streams) can serialize them.

export type DomainEvent =
  | { type: "invoice.created"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.partial"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.detected"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.confirmed"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.overpaid"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.expired"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.canceled"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  // Fires on EVERY confirmed inbound transfer that contributes to an invoice,
  // separate from the invoice-status transition events above. Gives merchants
  // audit-grade per-payment visibility — they can render "USDC 30.00 on
  // Polygon | ETH 0.02 on mainnet | USDT 45.00 on BSC" running totals on
  // their own side. The `payment` block carries the on-chain specifics;
  // the `invoice` block is the post-payment invoice snapshot.
  | {
      type: "invoice.payment_received";
      invoiceId: InvoiceId;
      invoice: Invoice;
      payment: {
        txHash: string;
        chainId: number;
        token: string;
        amountRaw: string;
        amountUsd: string | null;
        usdRate: string | null;
      };
      at: Date;
    }
  | { type: "tx.detected"; txId: TransactionId; tx: Transaction; at: Date }
  | { type: "tx.confirmed"; txId: TransactionId; tx: Transaction; at: Date }
  | { type: "tx.orphaned"; txId: TransactionId; tx: Transaction; at: Date }
  | { type: "payout.planned"; payoutId: PayoutId; payout: Payout; at: Date }
  | { type: "payout.submitted"; payoutId: PayoutId; payout: Payout; at: Date }
  | { type: "payout.confirmed"; payoutId: PayoutId; payout: Payout; at: Date }
  | { type: "payout.failed"; payoutId: PayoutId; payout: Payout; at: Date }
  // Pool-address lifecycle. Fired by pool.service when an HD-derived address
  // joins the pool (refill) or gets pulled out of rotation. The Alchemy
  // subscription tracker listens for these and enqueues per-chain
  // subscription rows — so one evm-family pool address fans out to all the
  // EVM chainIds we're watching via Alchemy.
  | { type: "pool.address.created"; poolAddressId: string; family: ChainFamily; address: string; addressIndex: number; at: Date }
  | { type: "pool.address.quarantined"; poolAddressId: string; family: ChainFamily; address: string; at: Date };

export type DomainEventType = DomainEvent["type"];

export type EventHandler<E extends DomainEvent = DomainEvent> = (event: E) => Promise<void> | void;

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;

  // Type-narrowed subscription: subscribe("invoice.confirmed", ...) gets an
  // Extract<DomainEvent, { type: "invoice.confirmed" }> typed argument.
  subscribe<T extends DomainEventType>(
    type: T,
    handler: EventHandler<Extract<DomainEvent, { type: T }>>
  ): () => void;

  // Useful for cross-cutting listeners (audit log, tracing) that want every event.
  subscribeAll(handler: EventHandler): () => void;
}
