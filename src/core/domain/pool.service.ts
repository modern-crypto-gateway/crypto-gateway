import type { AppDeps } from "../app-deps.js";
import { PoolExhaustedError } from "../errors.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import type { ChainFamily } from "../types/chain.js";
import type { PoolAddress, PoolFamilyStats } from "../types/pool.js";

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
    const candidate = await deps.db
      .prepare(
        `SELECT id, address, address_index FROM address_pool
         WHERE family = ? AND status = 'available'
         ORDER BY total_allocations ASC, address_index ASC
         LIMIT 1`
      )
      .bind(family)
      .first<{ id: string; address: string; address_index: number }>();

    if (candidate === null) {
      // Empty pool — kick off a background refill so the next invoice
      // creation has something to allocate, then surface the 503 so this
      // invoice-create call fails fast (merchant retries and succeeds once
      // the refill lands).
      scheduleRefill(deps, family);
      throw new PoolExhaustedError(family);
    }

    const claim = await deps.db
      .prepare(
        `UPDATE address_pool
           SET status = 'allocated', allocated_to_invoice_id = ?, allocated_at = ?
         WHERE id = ? AND status = 'available'
         RETURNING id, family, address_index, address, status,
                   allocated_to_invoice_id, allocated_at, total_allocations, created_at`
      )
      .bind(invoiceId, now, candidate.id)
      .first<PoolRow>();

    if (claim !== null) {
      // Post-allocation: check the available count; if below trigger,
      // schedule a background refill. This is what keeps the pool self-
      // healing without any cron support.
      const available = await countAvailable(deps, family);
      if (available < REFILL_TRIGGER_THRESHOLD) {
        scheduleRefill(deps, family);
      }
      return rowToPoolAddress(claim);
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
  await deps.db
    .prepare(
      `UPDATE address_pool
         SET status = 'available',
             allocated_to_invoice_id = NULL,
             allocated_at = NULL,
             total_allocations = total_allocations + 1
       WHERE allocated_to_invoice_id = ?`
    )
    .bind(invoiceId)
    .run();
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
    const maxRow = await deps.db
      .prepare("SELECT MAX(address_index) AS max_idx FROM address_pool WHERE family = ?")
      .bind(family)
      .first<{ max_idx: number | null }>();
    const startIdx = (maxRow?.max_idx ?? -1) + 1;
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
      deps.db
        .prepare(
          `INSERT INTO address_pool
             (id, family, address_index, address, status, total_allocations, created_at)
           VALUES (?, ?, ?, ?, 'available', 0, ?)`
        )
        .bind(d.id, family, d.index, d.address, now)
    );
    await deps.db.batch(inserts);

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
    .prepare(
      `SELECT family, status, COUNT(*) AS cnt, MAX(address_index) AS max_idx
         FROM address_pool
         GROUP BY family, status`
    )
    .all<{ family: ChainFamily; status: "available" | "allocated" | "quarantined"; cnt: number; max_idx: number | null }>();

  const byFamily = new Map<ChainFamily, PoolFamilyStats>();
  for (const row of rows.results) {
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
    if (row.max_idx !== null && (agg.highestIndex === null || row.max_idx > agg.highestIndex)) {
      agg.highestIndex = row.max_idx;
    }
    byFamily.set(row.family, agg);
  }
  return Array.from(byFamily.values()).sort((a, b) => a.family.localeCompare(b.family));
}

// ---- Internals ----

interface PoolRow {
  id: string;
  family: ChainFamily;
  address_index: number;
  address: string;
  status: "available" | "allocated" | "quarantined";
  allocated_to_invoice_id: string | null;
  allocated_at: number | null;
  total_allocations: number;
  created_at: number;
}

function rowToPoolAddress(row: PoolRow): PoolAddress {
  return {
    id: row.id,
    family: row.family,
    addressIndex: row.address_index,
    address: row.address,
    status: row.status,
    allocatedToInvoiceId: row.allocated_to_invoice_id,
    allocatedAt: row.allocated_at !== null ? new Date(row.allocated_at) : null,
    totalAllocations: row.total_allocations,
    createdAt: new Date(row.created_at)
  };
}

function findAdapterForFamily(deps: AppDeps, family: ChainFamily): ChainAdapter | null {
  return deps.chains.find((c) => c.family === family) ?? null;
}

async function countPool(deps: AppDeps, family: ChainFamily): Promise<number> {
  const row = await deps.db
    .prepare("SELECT COUNT(*) AS cnt FROM address_pool WHERE family = ?")
    .bind(family)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

async function countAvailable(deps: AppDeps, family: ChainFamily): Promise<number> {
  const row = await deps.db
    .prepare("SELECT COUNT(*) AS cnt FROM address_pool WHERE family = ? AND status = 'available'")
    .bind(family)
    .first<{ cnt: number }>();
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
