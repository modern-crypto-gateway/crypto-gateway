import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { webhookDeliveries } from "../../db/schema.js";
import type {
  InsertPendingArgs,
  MarkFailureArgs,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookDeliveryStore,
  WebhookResourceType
} from "../../core/ports/webhook-delivery-store.port.js";

// SQL-backed outbox. `INSERT … ON CONFLICT DO NOTHING` dedupes by
// idempotency_key — Drizzle's `onConflictDoNothing()` plus a `RETURNING id`
// reports whether the row was actually inserted vs. short-circuited by the
// unique-violation.

function drizzleRowToRecord(row: typeof webhookDeliveries.$inferSelect): WebhookDeliveryRecord {
  return {
    id: row.id,
    merchantId: row.merchantId,
    eventType: row.eventType,
    idempotencyKey: row.idempotencyKey,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    targetUrl: row.targetUrl,
    resourceType: row.resourceType as WebhookResourceType | null,
    resourceId: row.resourceId,
    status: row.status as WebhookDeliveryStatus,
    attempts: row.attempts,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function dbWebhookDeliveryStore(db: Db): WebhookDeliveryStore {
  return {
    async insertPending(args: InsertPendingArgs) {
      const inserted = await db
        .insert(webhookDeliveries)
        .values({
          id: args.id,
          merchantId: args.merchantId,
          eventType: args.eventType,
          idempotencyKey: args.idempotencyKey,
          payloadJson: JSON.stringify(args.payload),
          targetUrl: args.targetUrl,
          resourceType: args.resourceType,
          resourceId: args.resourceId,
          status: "pending",
          attempts: 0,
          lastStatusCode: null,
          lastError: null,
          nextAttemptAt: args.nextAttemptAt,
          deliveredAt: null,
          createdAt: args.now,
          updatedAt: args.now
        })
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id });
      return { inserted: inserted.length > 0 };
    },

    async markDelivered({ id, statusCode, now }) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "delivered",
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          lastStatusCode: statusCode,
          lastError: null,
          deliveredAt: now,
          updatedAt: now
        })
        .where(eq(webhookDeliveries.id, id));
    },

    async markFailure(args: MarkFailureArgs) {
      const status: WebhookDeliveryStatus = args.nextAttemptAt === null ? "dead" : "pending";
      // next_attempt_at is still persisted on 'dead' (as the last scheduled
      // time) for audit; the sweeper filters on status='pending' so a dead
      // row is never re-picked.
      const nextAt = args.nextAttemptAt ?? args.now;
      await db
        .update(webhookDeliveries)
        .set({
          status,
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          lastStatusCode: args.statusCode ?? null,
          lastError: args.error.slice(0, 2000),
          nextAttemptAt: nextAt,
          updatedAt: args.now
        })
        .where(eq(webhookDeliveries.id, args.id));
    },

    async listDueForRetry({ now, limit }) {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
        .orderBy(asc(webhookDeliveries.nextAttemptAt))
        .limit(limit);
      return rows.map(drizzleRowToRecord);
    },

    async listByStatus({ status, limit, offset }) {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.status, status))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit)
        .offset(offset);
      return rows.map(drizzleRowToRecord);
    },

    async getById(id) {
      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, id))
        .limit(1);
      return row ? drizzleRowToRecord(row) : null;
    },

    async resetForReplay({ id, nextAttemptAt, now }) {
      // Only move dead -> pending. A row already pending is not reset (the
      // sweeper owns those); a delivered row is not replayable (if the
      // merchant insists, re-POSTing from the admin surface creates a new row
      // with a distinct idempotency key — out of scope for this port).
      const updated = await db
        .update(webhookDeliveries)
        .set({
          status: "pending",
          nextAttemptAt,
          lastError: sql`COALESCE(${webhookDeliveries.lastError}, '') || ${" [replay "} || ${now} || ${"]"}`,
          updatedAt: now
        })
        .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "dead")))
        .returning({ id: webhookDeliveries.id });
      return { reset: updated.length > 0 };
    }
  };
}
