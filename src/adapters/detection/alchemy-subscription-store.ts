import type { DbAdapter } from "../../core/ports/db.port.js";

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

interface RawRow {
  id: string;
  chain_id: number;
  address: string;
  action: string;
  status: string;
  attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSubscription(row: RawRow): SubscriptionRow {
  return {
    id: row.id,
    chainId: row.chain_id,
    address: row.address,
    action: row.action as SubscriptionAction,
    status: row.status as SubscriptionStatus,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at === null ? null : new Date(row.last_attempt_at),
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export function dbAlchemySubscriptionStore(db: DbAdapter): AlchemySubscriptionStore {
  return {
    async insertPending({ chainId, address, action, now }) {
      const id = globalThis.crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO alchemy_address_subscriptions
             (id, chain_id, address, action, status, attempts, last_attempt_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`
        )
        .bind(id, chainId, address, action, now, now)
        .run();
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
      const result = await db
        .prepare(
          `SELECT * FROM alchemy_address_subscriptions
            WHERE status = 'pending'
              AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
            ORDER BY chain_id ASC, created_at ASC
            LIMIT ?`
        )
        .bind(threshold, limit)
        .all<RawRow>();
      return result.results.map(rowToSubscription);
    },

    async markSynced(ids, now) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      await db
        .prepare(
          `UPDATE alchemy_address_subscriptions
              SET status = 'synced', updated_at = ?, last_error = NULL
            WHERE id IN (${placeholders})`
        )
        .bind(now, ...ids)
        .run();
    },

    async markAttempted({ ids, now, error, maxAttempts }) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      // Bump attempts + record error. Promote to 'failed' when attempts
      // reach maxAttempts — the row stops retrying, operator gets to decide
      // whether to reset it or delete the webhook+address pair upstream.
      await db
        .prepare(
          `UPDATE alchemy_address_subscriptions
              SET attempts = attempts + 1,
                  last_attempt_at = ?,
                  last_error = ?,
                  updated_at = ?,
                  status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
            WHERE id IN (${placeholders})`
        )
        .bind(now, error.slice(0, 2048), now, maxAttempts, ...ids)
        .run();
    },

    async findByAddress(chainId, address) {
      const result = await db
        .prepare(
          `SELECT * FROM alchemy_address_subscriptions
            WHERE chain_id = ? AND address = ?
            ORDER BY created_at ASC`
        )
        .bind(chainId, address)
        .all<RawRow>();
      return result.results.map(rowToSubscription);
    },

    async countByStatus() {
      const result = await db
        .prepare(
          `SELECT status, COUNT(*) AS n
             FROM alchemy_address_subscriptions
            GROUP BY status`
        )
        .all<{ status: string; n: number }>();
      const out: Record<SubscriptionStatus, number> = { pending: 0, synced: 0, failed: 0 };
      for (const row of result.results) {
        if (row.status === "pending" || row.status === "synced" || row.status === "failed") {
          out[row.status] = row.n;
        }
      }
      return out;
    }
  };
}
