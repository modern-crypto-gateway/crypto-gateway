import { and, asc, count, eq, max, sql } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { PoolExhaustedError } from "../errors.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import type { ChainFamily } from "../types/chain.js";
import type { PoolAddress, PoolFamilyStats } from "../types/pool.js";
import { addressPool } from "../../db/schema.js";

// Address pool: shared-across-merchants, HD-derived, reused across invoices.
//
// Lifecycle:
//   refill   → HD-derive N new addresses, insert as 'available', emit
//              pool.address.created per row (Alchemy subscription tracker
//              picks them up and fans out to per-chain webhook registers).
//   allocate → CAS-update the cheapest available row (lowest total_allocations,
//              then lowest address_index) to 'allocated', tie to invoiceId.
//   release  → on invoice terminal, flip back to 'available' and bump
//              total_allocations. The same row can now serve the next invoice.
//   quarantine → ops action, pull a row out of rotation (not wired in A1.a
//              but the status exists so the table schema doesn't churn later).
//
// Concurrency:
//   - allocate uses a RETURNING-style CAS on a single row; retries on miss
//     so a lost race against another allocator just picks the next cheapest
//     row and retries rather than failing the request.
//   - refill is guarded by a cache-backed mutex (`putIfAbsent` on a
//     per-family lock key). If two refills race through the mutex check on
//     CF KV's eventually-consistent backend, the DB's UNIQUE(family,
//     address_index) constraint rejects the loser's inserts — both calls
//     complete successfully with the winner's indices.

// ---- Constants ----

// How many addresses to derive per refill batch.
const DEFAULT_REFILL_BATCH = 5;

// Trigger a background refill when available count drops below this.
const REFILL_TRIGGER_THRESHOLD = 3;

// Cap on allocate-CAS retry attempts before giving up. With heavy contention
// this fires a PoolExhaustedError (which in turn triggers a refill) — better
// to signal than to retry unboundedly on a legitimately-empty pool.
const ALLOCATE_RETRY_LIMIT = 5;

// Mutex TTL for the refill lock. Long enough to cover the longest realistic
// HD derivation + DB round-trip (<5s on any runtime). Short enough that a
// dead process releases the lock reasonably fast.
const REFILL_LOCK_TTL_SECONDS = 60;

// ---- Public API ----

export interface InitializePoolOptions {
  // Which families to seed. Families not wired in deps.chains are silently
  // skipped — no adapter = no HD derivation, so no point inserting empty
  // rows. Operator sees the skip in the returned `skipped` list.
  families: readonly ChainFamily[];
  // Target size per family after initialize. Idempotent top-up: if the pool
  // already has 3 rows and initialSize is 5, we add 2. If it already has 8,
  // we add none.
  initialSize: number;
}

export interface InitializePoolResult {
  family: ChainFamily;
  outcome: "topped-up" | "already-sufficient" | "skipped-no-adapter";
  priorCount: number;
  added: number;
}

export async function initializePool(
  deps: AppDeps,
  opts: InitializePoolOptions
): Promise<readonly InitializePoolResult[]> {
  const results: InitializePoolResult[] = [];
  for (const family of opts.families) {
    const adapter = findAdapterForFamily(deps, family);
    if (!adapter) {
      results.push({ family, outcome: "skipped-no-adapter", priorCount: 0, added: 0 });
      continue;
    }
    const prior = await countPool(deps, family);
    const needed = Math.max(0, opts.initialSize - prior);
    if (needed === 0) {
      results.push({ family, outcome: "already-sufficient", priorCount: prior, added: 0 });
      continue;
    }
    const added = await refillFamily(deps, family, needed);
    results.push({ family, outcome: "topped-up", priorCount: prior, added });
  }
  return results;
}

// Allocate one pool row to `invoiceId` for `family`. Throws PoolExhaustedError
// when no rows are available after the retry budget. Never triggers a
// synchronous refill (keeps invoice-create fast) — the caller schedules a
// background refill via deps.jobs when allocation succeeds near the threshold.
export async function allocateForInvoice(
  deps: AppDeps,
  invoiceId: string,
  family: ChainFamily
): Promise<PoolAddress> {
  const now = deps.clock.now().getTime();

  for (let attempt = 0; attempt < ALLOCATE_RETRY_LIMIT; attempt += 1) {
    const [candidate] = await deps.db
      .select({
        id: addressPool.id,
        address: addressPool.address,
        addressIndex: addressPool.addressIndex
      })
      .from(addressPool)
      .where(and(eq(addressPool.family, family), eq(addressPool.status, "available")))
      // Ordering rationale:
      //   1. totalAllocations ASC — never-used rows (count=0) win first.
      //   2. lastReleasedAt ASC NULLS FIRST — among rows with equal use count,
      //      longest-dormant wins; just-released rows go to the back. This
      //      gives a late payment to a recently expired invoice the longest
      //      possible window to land on the address that was tied to it
      //      rather than on a freshly-reused one. SQLite's default ASC
      //      ordering already places NULLs first, so the never-used (NULL
      //      lastReleasedAt) rows naturally win the tie inside the count=0
      //      bucket too.
      //   3. addressIndex ASC — deterministic final tiebreak, oldest derivation
      //      first.
      .orderBy(
        asc(addressPool.totalAllocations),
        asc(addressPool.lastReleasedAt),
        asc(addressPool.addressIndex)
      )
      .limit(1);

    if (!candidate) {
      // Empty pool — kick off a background refill so the next invoice
      // creation has something to allocate, then surface the 503 so this
      // invoice-create call fails fast (merchant retries and succeeds once
      // the refill lands).
      scheduleRefill(deps, family);
      throw new PoolExhaustedError(family);
    }

    const [claim] = await deps.db
      .update(addressPool)
      .set({ status: "allocated", allocatedToInvoiceId: invoiceId, allocatedAt: now })
      .where(and(eq(addressPool.id, candidate.id), eq(addressPool.status, "available")))
      .returning();

    if (claim) {
      // Post-allocation: check the available count; if below trigger,
      // schedule a background refill. This is what keeps the pool self-
      // healing without any cron support.
      const available = await countAvailable(deps, family);
      if (available < REFILL_TRIGGER_THRESHOLD) {
        scheduleRefill(deps, family);
      }
      return drizzleRowToPoolAddress(claim);
    }
    // CAS miss — another allocator got this row first. Retry with the next
    // cheapest candidate. This loop terminates because the pool is finite
    // and we cap at ALLOCATE_RETRY_LIMIT attempts.
  }
  throw new PoolExhaustedError(family);
}

// Release all pool rows tied to `invoiceId` back to 'available'. Called when
// an invoice reaches a terminal state (confirmed/expired/canceled). Bumps
// total_allocations on each released row so the fair-rotation ordering
// moves it to the back of the queue.
export async function releaseFromInvoice(deps: AppDeps, invoiceId: string): Promise<void> {
  const now = deps.clock.now().getTime();
  await deps.db
    .update(addressPool)
    .set({
      status: "available",
      allocatedToInvoiceId: null,
      allocatedAt: null,
      totalAllocations: sql`${addressPool.totalAllocations} + 1`,
      lastReleasedAt: now
    })
    .where(eq(addressPool.allocatedToInvoiceId, invoiceId));
}

// Re-claim the pool addresses previously held by `invoiceId` after a reorg
// demotion (confirmed → partial/detected/etc). For each address we try to
// atomically flip an 'available' pool row back to 'allocated' for this
// invoice. Returns counts so the caller can log the outcome:
//
//   reacquired: rows we successfully re-claimed (safe — no collision).
//   collided:   rows now allocated to a DIFFERENT invoice (the dangerous
//               case; a new invoice grabbed the slot before we could
//               re-claim it. Operator action required to avoid crediting
//               the wrong invoice.).
//
// No-op for addresses that are still held by this invoice (idempotent).
export async function reacquireForInvoice(
  deps: AppDeps,
  invoiceId: string,
  addresses: readonly string[]
): Promise<{ reacquired: number; collided: number }> {
  if (addresses.length === 0) return { reacquired: 0, collided: 0 };
  const now = deps.clock.now().getTime();
  let reacquired = 0;
  let collided = 0;
  for (const address of addresses) {
    const updated = await deps.db
      .update(addressPool)
      .set({ status: "allocated", allocatedToInvoiceId: invoiceId, allocatedAt: now })
      .where(and(eq(addressPool.address, address), eq(addressPool.status, "available")))
      .returning({ id: addressPool.id });
    if (updated.length > 0) {
      reacquired += 1;
      continue;
    }
    // Nothing changed — either this invoice already holds the row (safe) or
    // a different invoice does (collision). One extra SELECT to tell them
    // apart. The cost is per-reorg-demotion, which is rare.
    const [row] = await deps.db
      .select({ allocatedToInvoiceId: addressPool.allocatedToInvoiceId })
      .from(addressPool)
      .where(eq(addressPool.address, address))
      .limit(1);
    const held = row?.allocatedToInvoiceId ?? null;
    if (held !== null && held !== invoiceId) collided += 1;
  }
  return { reacquired, collided };
}

// Derive `count` new addresses for `family`, insert as 'available', emit
// pool.address.created per row. Idempotent under contention via the cache
// mutex — if another refill is mid-flight, this call is a no-op and returns 0.
// Returns the number of rows actually inserted.
export async function refillFamily(
  deps: AppDeps,
  family: ChainFamily,
  count: number
): Promise<number> {
  if (count <= 0) return 0;
  const lockKey = `pool:refill-lock:${family}`;
  const acquired = await deps.cache.putIfAbsent(lockKey, "1", { ttlSeconds: REFILL_LOCK_TTL_SECONDS });
  if (!acquired) return 0;
  try {
    const adapter = findAdapterForFamily(deps, family);
    if (!adapter) {
      deps.logger.warn("pool refill skipped: no chain adapter wired for family", { family });
      return 0;
    }
    const seed = deps.secrets.getRequired("MASTER_SEED");
    const [maxRow] = await deps.db
      .select({ maxIdx: max(addressPool.addressIndex) })
      .from(addressPool)
      .where(eq(addressPool.family, family));
    const startIdx = (maxRow?.maxIdx ?? -1) + 1;
    const now = deps.clock.now().getTime();

    // Derive addresses synchronously (local crypto, no I/O), then insert in
    // one batch so a partial failure doesn't leave the pool in a half-built
    // state. The UNIQUE(family, address_index) constraint catches any race
    // where a second refill slipped through the cache mutex.
    type DerivedRow = { id: string; address: string; index: number };
    const derived: DerivedRow[] = [];
    for (let i = 0; i < count; i += 1) {
      const index = startIdx + i;
      const { address } = adapter.deriveAddress(seed, index);
      derived.push({ id: globalThis.crypto.randomUUID(), address, index });
    }

    const inserts = derived.map((d) =>
      deps.db.insert(addressPool).values({
        id: d.id,
        family,
        addressIndex: d.index,
        address: d.address,
        status: "available",
        totalAllocations: 0,
        createdAt: now
      })
    );
    if (inserts.length > 0) {
      type InsertStmt = (typeof inserts)[number];
      await deps.db.batch(inserts as [InsertStmt, ...InsertStmt[]]);
    }

    // Publish pool.address.created events so the Alchemy subscription
    // tracker can enqueue per-chain `add` rows. Publish is fire-and-forget
    // at the bus layer — subscribers run async via the event handler.
    for (const d of derived) {
      await deps.events.publish({
        type: "pool.address.created",
        poolAddressId: d.id,
        family,
        address: d.address,
        addressIndex: d.index,
        at: new Date(now)
      });
    }

    deps.logger.info("pool refilled", { family, count: derived.length, startIndex: startIdx });
    return derived.length;
  } catch (err) {
    deps.logger.error("pool refill failed", {
      family,
      error: err instanceof Error ? err.message : String(err)
    });
    throw err;
  } finally {
    await deps.cache.delete(lockKey);
  }
}

// Event-bus subscriber: releases pool rows when the owning invoice reaches a
// terminal state. Installed once per buildApp; unsubscriber returned so tests
// can tear down cleanly.
export function registerPoolReleaseHandler(deps: AppDeps): () => void {
  const handler = async (event: { invoice: { id: string } }): Promise<void> => {
    try {
      await releaseFromInvoice(deps, event.invoice.id);
    } catch (err) {
      deps.logger.error("pool release failed on invoice terminal transition", {
        invoiceId: event.invoice.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const unsubscribers = [
    deps.events.subscribe("invoice.confirmed", handler),
    deps.events.subscribe("invoice.expired", handler),
    deps.events.subscribe("invoice.canceled", handler)
  ];
  return () => {
    for (const u of unsubscribers) u();
  };
}

export async function getStats(deps: AppDeps): Promise<readonly PoolFamilyStats[]> {
  const rows = await deps.db
    .select({
      family: addressPool.family,
      status: addressPool.status,
      cnt: count(),
      maxIdx: max(addressPool.addressIndex)
    })
    .from(addressPool)
    .groupBy(addressPool.family, addressPool.status);

  const byFamily = new Map<ChainFamily, PoolFamilyStats>();
  for (const row of rows) {
    const agg = byFamily.get(row.family) ?? {
      family: row.family,
      available: 0,
      allocated: 0,
      quarantined: 0,
      total: 0,
      highestIndex: null as number | null
    };
    agg[row.status] = row.cnt;
    agg.total += row.cnt;
    if (row.maxIdx !== null && (agg.highestIndex === null || row.maxIdx > agg.highestIndex)) {
      agg.highestIndex = row.maxIdx;
    }
    byFamily.set(row.family, agg);
  }
  return Array.from(byFamily.values()).sort((a, b) => a.family.localeCompare(b.family));
}

// ---- Internals ----

function drizzleRowToPoolAddress(row: typeof addressPool.$inferSelect): PoolAddress {
  return {
    id: row.id,
    family: row.family,
    addressIndex: row.addressIndex,
    address: row.address,
    status: row.status,
    allocatedToInvoiceId: row.allocatedToInvoiceId,
    allocatedAt: row.allocatedAt !== null ? new Date(row.allocatedAt) : null,
    totalAllocations: row.totalAllocations,
    createdAt: new Date(row.createdAt)
  };
}

function findAdapterForFamily(deps: AppDeps, family: ChainFamily): ChainAdapter | null {
  return deps.chains.find((c) => c.family === family) ?? null;
}

async function countPool(deps: AppDeps, family: ChainFamily): Promise<number> {
  const [row] = await deps.db
    .select({ cnt: count() })
    .from(addressPool)
    .where(eq(addressPool.family, family));
  return row?.cnt ?? 0;
}

async function countAvailable(deps: AppDeps, family: ChainFamily): Promise<number> {
  const [row] = await deps.db
    .select({ cnt: count() })
    .from(addressPool)
    .where(and(eq(addressPool.family, family), eq(addressPool.status, "available")));
  return row?.cnt ?? 0;
}

// Kick off a refill in the background. On Workers this wraps ctx.waitUntil;
// on Node it's a promise-set entry. Per-family "reason" so the jobs adapter
// can de-dupe concurrent kicks by name if it wants to.
function scheduleRefill(deps: AppDeps, family: ChainFamily): void {
  deps.jobs.defer(
    async () => {
      try {
        await refillFamily(deps, family, DEFAULT_REFILL_BATCH);
      } catch (err) {
        // refillFamily already logs — swallow here so `defer` doesn't double-report.
        void err;
      }
    },
    { name: `pool-refill:${family}` }
  );
}
