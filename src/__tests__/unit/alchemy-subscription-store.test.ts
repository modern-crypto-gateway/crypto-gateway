import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { libsqlAdapter } from "../../adapters/db/libsql.adapter.js";
import {
  dbAlchemySubscriptionStore,
  type AlchemySubscriptionStore
} from "../../adapters/detection/alchemy-subscription-store.js";

async function freshStore(): Promise<{ store: AlchemySubscriptionStore; db: ReturnType<typeof libsqlAdapter> }> {
  const db = libsqlAdapter({ url: ":memory:" });
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, "..", "..", "..", "migrations", "schema.sql");
  await db.exec(readFileSync(schemaPath, "utf8"));
  return { store: dbAlchemySubscriptionStore(db), db };
}

describe("dbAlchemySubscriptionStore", () => {
  let store: AlchemySubscriptionStore;

  beforeEach(async () => {
    ({ store } = await freshStore());
  });

  it("insertPending creates a row in 'pending' state with attempts=0", async () => {
    const id = await store.insertPending({ chainId: 1, address: "0xaa", action: "add", now: 1_000 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await store.findByAddress(1, "0xaa");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 0, action: "add" });
  });

  it("claimPending returns rows whose last_attempt_at is older than the backoff (or null)", async () => {
    await store.insertPending({ chainId: 1, address: "0xaa", action: "add", now: 1_000 });
    // Claim immediately — last_attempt_at is NULL, so it's eligible.
    const firstBatch = await store.claimPending({ now: 2_000, backoffMs: 5 * 60 * 1000, limit: 10 });
    expect(firstBatch).toHaveLength(1);

    // Bump attempt. Now it should be ineligible until the backoff elapses.
    await store.markAttempted({ ids: [firstBatch[0]!.id], now: 2_000, error: "rate limited", maxAttempts: 10 });

    // Just a second later -> within the 5 min backoff window, not re-eligible.
    const secondBatch = await store.claimPending({ now: 2_500, backoffMs: 5 * 60 * 1000, limit: 10 });
    expect(secondBatch).toHaveLength(0);

    // Past the backoff window -> eligible again.
    const thirdBatch = await store.claimPending({ now: 2_000 + 6 * 60 * 1000, backoffMs: 5 * 60 * 1000, limit: 10 });
    expect(thirdBatch).toHaveLength(1);
  });

  it("markSynced transitions rows to status='synced' and clears last_error", async () => {
    const id1 = await store.insertPending({ chainId: 1, address: "0xa1", action: "add", now: 1_000 });
    const id2 = await store.insertPending({ chainId: 1, address: "0xa2", action: "add", now: 1_000 });
    await store.markAttempted({ ids: [id1], now: 1_500, error: "prev error", maxAttempts: 10 });

    await store.markSynced([id1, id2], 2_000);
    const counts = await store.countByStatus();
    expect(counts).toEqual({ pending: 0, synced: 2, failed: 0 });

    const rows = await store.findByAddress(1, "0xa1");
    expect(rows[0]?.status).toBe("synced");
    expect(rows[0]?.lastError).toBeNull();
  });

  it("markAttempted bumps attempts; flips to 'failed' at maxAttempts", async () => {
    const id = await store.insertPending({ chainId: 1, address: "0xaa", action: "add", now: 1_000 });

    for (let i = 1; i < 3; i += 1) {
      await store.markAttempted({ ids: [id], now: 1_000 + i * 1000, error: "err", maxAttempts: 3 });
    }

    const rowsMid = await store.findByAddress(1, "0xaa");
    expect(rowsMid[0]?.status).toBe("pending");
    expect(rowsMid[0]?.attempts).toBe(2);

    await store.markAttempted({ ids: [id], now: 5_000, error: "err", maxAttempts: 3 });
    const rowsDone = await store.findByAddress(1, "0xaa");
    expect(rowsDone[0]?.status).toBe("failed");
    expect(rowsDone[0]?.attempts).toBe(3);
  });

  it("claimPending skips 'synced' and 'failed' rows", async () => {
    const id1 = await store.insertPending({ chainId: 1, address: "0xa1", action: "add", now: 1_000 });
    const id2 = await store.insertPending({ chainId: 1, address: "0xa2", action: "add", now: 1_000 });
    const id3 = await store.insertPending({ chainId: 1, address: "0xa3", action: "add", now: 1_000 });

    await store.markSynced([id1], 2_000);
    // Force id2 to 'failed' by exceeding maxAttempts=1 quickly.
    await store.markAttempted({ ids: [id2], now: 2_000, error: "e", maxAttempts: 1 });

    const claimed = await store.claimPending({ now: 10_000_000, backoffMs: 60_000, limit: 10 });
    expect(claimed.map((r) => r.id)).toEqual([id3]);
  });

  it("claimPending orders by (chain_id ASC, created_at ASC) for deterministic batching", async () => {
    // Insert cross-chain in scrambled order.
    const a = await store.insertPending({ chainId: 137, address: "0xa", action: "add", now: 1_000 });
    const b = await store.insertPending({ chainId: 1, address: "0xb", action: "add", now: 2_000 });
    const c = await store.insertPending({ chainId: 1, address: "0xc", action: "add", now: 3_000 });
    const d = await store.insertPending({ chainId: 137, address: "0xd", action: "add", now: 4_000 });

    const claimed = await store.claimPending({ now: 10_000, backoffMs: 1, limit: 100 });
    expect(claimed.map((r) => r.id)).toEqual([b, c, a, d]);
  });

  it("countByStatus returns zeros for missing buckets instead of undefined", async () => {
    expect(await store.countByStatus()).toEqual({ pending: 0, synced: 0, failed: 0 });
    await store.insertPending({ chainId: 1, address: "0xa", action: "add", now: 1_000 });
    expect(await store.countByStatus()).toEqual({ pending: 1, synced: 0, failed: 0 });
  });
});
