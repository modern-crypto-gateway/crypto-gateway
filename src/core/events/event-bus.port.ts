import type { ChainFamily } from "../types/chain.js";
import type { Invoice, InvoiceId, InvoiceStatus } from "../types/invoice.js";
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
  // Internal — never reaches merchants (POST /invoices returns synchronously,
  // so a separate webhook for creation would be redundant noise).
  | { type: "invoice.created"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  // Whole-invoice lifecycle. Fires once when the invoice transitions to
  // status='completed'. Overpaid invoices fire this same event with
  // extra_status='overpaid' on the snapshot — overpayment is a fidelity
  // signal, not a separate lifecycle stage.
  | { type: "invoice.completed"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.expired"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  | { type: "invoice.canceled"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  // Mid-lifecycle signal. Fires when an invoice transitions INTO `processing`
  // — either pending → processing (first contributing transfer detected) or
  // a same-status extra-status flip (e.g. processing(partial) →
  // processing(no extra) once enough has been received). Lets merchants
  // drive a "payment in flight" UI without subscribing to every per-tx
  // event. Idempotency key encodes status + extra_status so each distinct
  // processing flavor delivers exactly once (partial vs full-but-unconfirmed).
  | { type: "invoice.processing"; invoiceId: InvoiceId; invoice: Invoice; at: Date }
  // Reorg un-confirmation. Fired BEFORE the normal status-transition event
  // when a previously completed invoice is demoted back to processing/pending
  // because the chain rolled back the underlying transaction(s).
  // `previousStatus` is the pre-demotion main status ('completed');
  // `invoice.status` carries the new one. `poolReacquired` / `poolCollided`
  // report whether the receive addresses were successfully re-claimed from
  // the pool — `collided > 0` means a new invoice had already grabbed the
  // slot and manual reconciliation is needed.
  | {
      type: "invoice.demoted";
      invoiceId: InvoiceId;
      invoice: Invoice;
      previousStatus: InvoiceStatus;
      poolReacquired: number;
      poolCollided: number;
      at: Date;
    }
  // Per-transfer event fired the FIRST time a transfer contributing to an
  // invoice is observed, BEFORE it crosses the confirmation threshold. Pairs
  // with `invoice.payment_confirmed` (same tx, post-confirmation). Idempotency
  // keys on (invoice id, tx hash) so redelivery never duplicates.
  | {
      type: "invoice.payment_detected";
      invoiceId: InvoiceId;
      invoice: Invoice;
      payment: {
        txHash: string;
        chainId: number;
        token: string;
        amountRaw: string;
        amountUsd: string | null;
        usdRate: string | null;
        confirmations: number;
      };
      at: Date;
    }
  // Per-transfer event fired when a contributing transfer reaches the chain's
  // confirmation threshold. Audit-grade signal: the money is durable. Fires
  // even when the invoice itself hasn't reached `completed` yet (partial
  // payments produce one of these per confirmed contributing tx). Gives
  // merchants per-payment running-total visibility on multi-tx invoices.
  | {
      type: "invoice.payment_confirmed";
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

  // Type-narrowed subscription: subscribe("invoice.completed", ...) gets an
  // Extract<DomainEvent, { type: "invoice.completed" }> typed argument.
  subscribe<T extends DomainEventType>(
    type: T,
    handler: EventHandler<Extract<DomainEvent, { type: T }>>
  ): () => void;

  // Useful for cross-cutting listeners (audit log, tracing) that want every event.
  subscribeAll(handler: EventHandler): () => void;
}
