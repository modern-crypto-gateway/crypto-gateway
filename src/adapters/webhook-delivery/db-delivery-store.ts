import type { DbAdapter } from "../../core/ports/db.port.js";
import type {
  InsertPendingArgs,
  MarkFailureArgs,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookDeliveryStore
} from "../../core/ports/webhook-delivery-store.port.js";

// SQL-backed outbox. `INSERT OR IGNORE` is used to dedupe by idempotency_key —
// on SQLite that's the idiomatic "INSERT if not exists" and returns zero
// changes when the row already exists, which we surface as `inserted: false`.

interface RawRow {
  id: string;
  merchant_id: string;
  event_type: string;
  idempotency_key: string;
  payload_json: string;
  target_url: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: number;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToRecord(row: RawRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    targetUrl: row.target_url,
    status: row.status as WebhookDeliveryStatus,
    attempts: row.attempts,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function dbWebhookDeliveryStore(db: DbAdapter): WebhookDeliveryStore {
  return {
    async insertPending(args: InsertPendingArgs) {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO webhook_deliveries
             (id, merchant_id, event_type, idempotency_key, payload_json, target_url,
              status, attempts, last_status_code, last_error, next_attempt_at,
              delivered_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL, ?, ?)`
        )
        .bind(
          args.id,
          args.merchantId,
          args.eventType,
          args.idempotencyKey,
          JSON.stringify(args.payload),
          args.targetUrl,
          args.nextAttemptAt,
          args.now,
          args.now
        )
        .run();
      // D1/libSQL return `meta.changes`; 0 means the idempotency_key collided
      // with an existing row and the INSERT OR IGNORE short-circuited.
      return { inserted: (result.meta.changes ?? 0) > 0 };
    },

    async markDelivered({ id, statusCode, now }) {
      await db
        .prepare(
          `UPDATE webhook_deliveries
              SET status = 'delivered',
                  attempts = attempts + 1,
                  last_status_code = ?,
                  last_error = NULL,
                  delivered_at = ?,
                  updated_at = ?
            WHERE id = ?`
        )
        .bind(statusCode, now, now, id)
        .run();
    },

    async markFailure(args: MarkFailureArgs) {
      const status: WebhookDeliveryStatus = args.nextAttemptAt === null ? "dead" : "pending";
      // next_attempt_at is still persisted on 'dead' (as the last scheduled
      // time) for audit; the sweeper filters on status='pending' so a dead
      // row is never re-picked.
      const nextAt = args.nextAttemptAt ?? args.now;
      await db
        .prepare(
          `UPDATE webhook_deliveries
              SET status = ?,
                  attempts = attempts + 1,
                  last_status_code = ?,
                  last_error = ?,
                  next_attempt_at = ?,
                  updated_at = ?
            WHERE id = ?`
        )
        .bind(
          status,
          args.statusCode ?? null,
          args.error.slice(0, 2000),
          nextAt,
          args.now,
          args.id
        )
        .run();
    },

    async listDueForRetry({ now, limit }) {
      const rows = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY next_attempt_at ASC
            LIMIT ?`
        )
        .bind(now, limit)
        .all<RawRow>();
      return rows.results.map(rowToRecord);
    },

    async listByStatus({ status, limit, offset }) {
      const rows = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
            WHERE status = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?`
        )
        .bind(status, limit, offset)
        .all<RawRow>();
      return rows.results.map(rowToRecord);
    },

    async getById(id) {
      const row = await db
        .prepare("SELECT * FROM webhook_deliveries WHERE id = ?")
        .bind(id)
        .first<RawRow>();
      return row === null ? null : rowToRecord(row);
    },

    async resetForReplay({ id, nextAttemptAt, now }) {
      // Only move dead -> pending. A row already pending is not reset (the
      // sweeper owns those); a delivered row is not replayable (if the
      // merchant insists, re-POSTing from the admin surface creates a new row
      // with a distinct idempotency key — out of scope for this port).
      const result = await db
        .prepare(
          `UPDATE webhook_deliveries
              SET status = 'pending',
                  next_attempt_at = ?,
                  last_error = COALESCE(last_error, '') || ' [replay ' || ? || ']',
                  updated_at = ?
            WHERE id = ? AND status = 'dead'`
        )
        .bind(nextAttemptAt, now, now, id)
        .run();
      return { reset: (result.meta.changes ?? 0) > 0 };
    }
  };
}
