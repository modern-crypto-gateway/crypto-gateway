import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { alchemyAddressSubscriptions } from "../../db/schema.js";

// Alchemy address-subscription queue store. Each row is one pending/synced/failed
// `add` or `remove` operation against a webhook's watched-addresses set. The
// tracker enqueues, the sweep claims + resolves.
//
// Separated from the sweep itself so test setup can seed rows directly without
// mounting a full AlchemyAdminClient.

export type SubscriptionAction = "add" | "remove";
export type SubscriptionStatus = "pending" | "synced" | "failed";

export interface SubscriptionRow {
  id: string;
  chainId: number;
  address: string;
  action: SubscriptionAction;
  status: SubscriptionStatus;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertPendingArgs {
  chainId: number;
  address: string;
  action: SubscriptionAction;
  now: number;
}

export interface AlchemySubscriptionStore {
  insertPending(args: InsertPendingArgs): Promise<string>;
  // Pending rows eligible for an attempt (status='pending' AND either
  // never-attempted OR last_attempt_at <= now - backoff). Grouped by chain
  // by the caller — the store just returns them flat.
  claimPending(args: { now: number; backoffMs: number; limit: number }): Promise<readonly SubscriptionRow[]>;
  markSynced(ids: readonly string[], now: number): Promise<void>;
  // Bump attempts, record error. If attempts>=maxAttempts, move to 'failed'.
  markAttempted(args: {
    ids: readonly string[];
    now: number;
    error: string;
    maxAttempts: number;
  }): Promise<void>;
  findByAddress(chainId: number, address: string): Promise<readonly SubscriptionRow[]>;
  countByStatus(): Promise<Record<SubscriptionStatus, number>>;
}

function drizzleRowToSubscription(row: typeof alchemyAddressSubscriptions.$inferSelect): SubscriptionRow {
  return {
    id: row.id,
    chainId: row.chainId,
    address: row.address,
    action: row.action,
    status: row.status,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt === null ? null : new Date(row.lastAttemptAt),
    lastError: row.lastError,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

export function dbAlchemySubscriptionStore(db: Db): AlchemySubscriptionStore {
  return {
    async insertPending({ chainId, address, action, now }) {
      const id = globalThis.crypto.randomUUID();
      await db.insert(alchemyAddressSubscriptions).values({
        id,
        chainId,
        address,
        action,
        status: "pending",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now
      });
      return id;
    },

    async claimPending({ now, backoffMs, limit }) {
      // "Due for an attempt" = status='pending' AND (never attempted OR last
      // attempt was > backoffMs ago). We don't lock the rows here — the caller
      // marks each batch after the API call, so concurrent sweeps on the same
      // DB would double-attempt the same batch. In practice only one cron
      // invocation runs at a time, so fine; a transactional claim is a Phase
      // 10+ concern when we have multiple horizontally scaled workers.
      const threshold = now - backoffMs;
      const rows = await db
        .select()
        .from(alchemyAddressSubscriptions)
        .where(
          and(
            eq(alchemyAddressSubscriptions.status, "pending"),
            or(
              isNull(alchemyAddressSubscriptions.lastAttemptAt),
              lte(alchemyAddressSubscriptions.lastAttemptAt, threshold)
            )
          )
        )
        .orderBy(asc(alchemyAddressSubscriptions.chainId), asc(alchemyAddressSubscriptions.createdAt))
        .limit(limit);
      return rows.map(drizzleRowToSubscription);
    },

    async markSynced(ids, now) {
      if (ids.length === 0) return;
      await db
        .update(alchemyAddressSubscriptions)
        .set({
          status: "synced",
          updatedAt: now,
          lastError: null
        })
        .where(inArray(alchemyAddressSubscriptions.id, ids as string[]));
    },

    async markAttempted({ ids, now, error, maxAttempts }) {
      if (ids.length === 0) return;
      // Bump attempts + record error. Promote to 'failed' when attempts
      // reach maxAttempts — the row stops retrying, operator gets to decide
      // whether to reset it or delete the webhook+address pair upstream.
      await db
        .update(alchemyAddressSubscriptions)
        .set({
          attempts: sql`${alchemyAddressSubscriptions.attempts} + 1`,
          lastAttemptAt: now,
          lastError: error.slice(0, 2048),
          updatedAt: now,
          status: sql`CASE WHEN ${alchemyAddressSubscriptions.attempts} + 1 >= ${maxAttempts} THEN 'failed' ELSE ${alchemyAddressSubscriptions.status} END`
        })
        .where(inArray(alchemyAddressSubscriptions.id, ids as string[]));
    },

    async findByAddress(chainId, address) {
      const rows = await db
        .select()
        .from(alchemyAddressSubscriptions)
        .where(
          and(
            eq(alchemyAddressSubscriptions.chainId, chainId),
            eq(alchemyAddressSubscriptions.address, address)
          )
        )
        .orderBy(asc(alchemyAddressSubscriptions.createdAt));
      return rows.map(drizzleRowToSubscription);
    },

    async countByStatus() {
      const rows = await db
        .select({
          status: alchemyAddressSubscriptions.status,
          n: sql<number>`COUNT(*)`
        })
        .from(alchemyAddressSubscriptions)
        .groupBy(alchemyAddressSubscriptions.status);
      const out: Record<SubscriptionStatus, number> = { pending: 0, synced: 0, failed: 0 };
      for (const row of rows) {
        if (row.status === "pending" || row.status === "synced" || row.status === "failed") {
          out[row.status] = Number(row.n);
        }
      }
      return out;
    }
  };
}
