// Persistent dead-letter queue for merchant webhooks. The subscriber writes a
// row BEFORE the dispatcher runs (outbox pattern), then updates the row to
// 'delivered' / 'dead' based on the dispatch outcome. If the process is killed
// mid-dispatch, the row stays 'pending' and the scheduled-jobs sweeper retries
// it past next_attempt_at.
//
// Separate from `WebhookDispatcher` (which does the HTTP call + in-memory
// retries) so the two can evolve independently — e.g. a future CF Queues
// dispatcher would still need this port for the replay API.

export type WebhookDeliveryStatus = "pending" | "delivered" | "dead";

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly targetUrl: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: number;
  readonly deliveredAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertPendingArgs {
  readonly id: string;
  readonly merchantId: string;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly targetUrl: string;
  readonly nextAttemptAt: number;
  readonly now: number;
}

export interface MarkFailureArgs {
  readonly id: string;
  readonly statusCode?: number;
  readonly error: string;
  // null => permanent failure, row becomes 'dead'. A number => remain 'pending'
  // and retry at that epoch-ms.
  readonly nextAttemptAt: number | null;
  readonly now: number;
}

export interface WebhookDeliveryStore {
  // Returns { inserted: false } if a row with the same idempotency_key already
  // exists — the caller treats that as "already queued" and does not dispatch.
  insertPending(args: InsertPendingArgs): Promise<{ inserted: boolean }>;

  markDelivered(args: { id: string; statusCode: number; now: number }): Promise<void>;

  markFailure(args: MarkFailureArgs): Promise<void>;

  // Rows the sweeper should retry: status='pending' AND next_attempt_at <= now.
  // Limit caps the sweep per tick so a backlog can't stall the scheduled-jobs
  // runner.
  listDueForRetry(args: { now: number; limit: number }): Promise<readonly WebhookDeliveryRecord[]>;

  listByStatus(args: {
    status: WebhookDeliveryStatus;
    limit: number;
    offset: number;
  }): Promise<readonly WebhookDeliveryRecord[]>;

  getById(id: string): Promise<WebhookDeliveryRecord | null>;

  // Admin replay: reset a dead row to pending with a fresh next_attempt_at.
  // Returns { reset: false } if the row wasn't in 'dead' status (race with
  // sweeper, already replayed). Attempts counter is NOT reset — we want the
  // history for debugging.
  resetForReplay(args: { id: string; nextAttemptAt: number; now: number }): Promise<{ reset: boolean }>;
}
