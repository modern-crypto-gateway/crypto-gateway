import { and, asc, count, eq, inArray, isNull, lt, lte, max, notInArray, or, sql } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { PoolExhaustedError } from "../errors.js";
import type { Address, ChainId } from "../types/chain.js";
import { findChainAdapter } from "./chain-lookup.js";
import {
  isMoneroChainAdapter,
  type MoneroChainAdapter
} from "../../adapters/chains/monero/monero-chain.adapter.js";
import { deriveSubaddress } from "../../adapters/chains/monero/monero-crypto.js";
import { invoices, merchants, moneroSubaddressCounters, moneroSubaddressPool } from "../../db/schema.js";

// Reusable Monero subaddress pool. The Monero analogue of `pool.service.ts`,
// kept entirely separate because Monero is inbound-only (the gateway holds the
// view key, never the spend key) and must never touch the shared `address_pool`
// — that table is coupled to spend-side logic (consolidation, fee wallets,
// payout sourcing) that would be structurally illegal for Monero.
//
// Lifecycle (identical shape to the shared pool, keyed by chainId not family):
//   refill   → derive N subaddresses under account 0 via the adapter's view key
//              + primary spend pub, insert as 'available'. Indices start at or
//              above `monero_subaddress_counters.next_index` so they never
//              collide with subaddresses the legacy per-invoice allocator
//              already handed out; the counter is bumped forward in lock-step.
//   allocate → CAS-update the cheapest available row to 'allocated', tie to the
//              invoiceId. Skips rows still in cooldown.
//   release  → on invoice terminal, flip back to 'available', bump
//              total_allocations, and stamp a cooldown floor (see below).
//
// Cooldown: a released subaddress stays out of rotation for at least
// MONERO_POOL_COOLDOWN (default 60 min, configurable). This is the guard
// against a late payment to an expired invoice being mis-credited to the next
// invoice that reuses the same subaddress — during cooldown the address is not
// re-handed-out, so the late payment credits the original invoice (via the
// terminal-in-cooldown branch in payment.service.ts). Because Monero has no
// payment IDs, a payment that confirms long after expiry, once the address has
// been reused, is irreducibly ambiguous; the cooldown shrinks that window.

// ---- Constants ----

const DEFAULT_REFILL_BATCH = 5;
const REFILL_TRIGGER_THRESHOLD = 3;
const ALLOCATE_RETRY_LIMIT = 5;
const REFILL_LOCK_TTL_SECONDS = 60;
const ORPHAN_GRACE_MS = 60 * 1000;
const RECONCILE_ACTIVE_INVOICE_FETCH_LIMIT = 10_000;

// Fallbacks when the entrypoint didn't thread the config knobs into AppDeps.
const DEFAULT_MONERO_POOL_COOLDOWN_SECONDS = 3600; // 60 min
const DEFAULT_MONERO_POOL_INITIAL_SIZE = 20;

// Soft visibility threshold on the LIVE ROW COUNT (not the absolute index).
// When the pool exceeds this many rows, churn is outrunning reuse — invoices
// are being created faster than the cooldown frees subaddresses — so we log a
// hint to raise MONERO_POOL_INITIAL_SIZE or lower MONERO_POOL_COOLDOWN_SECONDS.
//
// This is NOT a hard cap. The pool grows as needed (like the shared pool) so a
// paying customer is never rejected. Crucially the bound is on COUNT, never on
// the absolute subaddress index: a deployment migrating off the legacy
// per-invoice allocator can have a high index high-water mark (thousands) while
// its live reused set stays tiny. Indices grow contiguously above that mark,
// which a Monero wallet's subaddress lookahead auto-extends to cover.
const POOL_SIZE_SOFT_WARN = 200;

// ---- Public API ----

export interface AllocatedMoneroSubaddress {
  readonly id: string;
  readonly address: Address;
  readonly addressIndex: number;
}

// Allocate one available subaddress on `chainId` to `invoiceId`. Throws
// PoolExhaustedError when no row is available after the retry budget (the
// caller surfaces it as the existing 503). Schedules a background refill near
// the threshold so the pool self-heals without cron support.
export async function allocateMoneroFromPool(
  deps: AppDeps,
  invoiceId: string,
  chainId: ChainId
): Promise<AllocatedMoneroSubaddress> {
  const now = deps.clock.now().getTime();

  for (let attempt = 0; attempt < ALLOCATE_RETRY_LIMIT; attempt += 1) {
    // Single-statement allocate (same proven CAS shape as allocateForInvoice):
    // pick the cheapest available row via subquery and atomically claim it.
    // Ordering: never-used rows (total_allocations=0) first, then
    // longest-dormant (last_released_at ASC NULLS FIRST), then lowest index.
    const candidateSubquery = deps.db
      .select({ id: moneroSubaddressPool.id })
      .from(moneroSubaddressPool)
      .where(
        and(
          eq(moneroSubaddressPool.chainId, chainId),
          eq(moneroSubaddressPool.status, "available"),
          or(
            isNull(moneroSubaddressPool.cooldownUntil),
            lte(moneroSubaddressPool.cooldownUntil, now)
          )
        )
      )
      .orderBy(
        asc(moneroSubaddressPool.totalAllocations),
        asc(moneroSubaddressPool.lastReleasedAt),
        asc(moneroSubaddressPool.addressIndex)
      )
      .limit(1);

    const [claim] = await deps.db
      .update(moneroSubaddressPool)
      .set({
        status: "allocated",
        allocatedToInvoiceId: invoiceId,
        allocatedAt: now,
        cooldownUntil: null,
        lastReleasedByMerchantId: null
      })
      .where(
        and(
          inArray(moneroSubaddressPool.id, candidateSubquery),
          eq(moneroSubaddressPool.status, "available")
        )
      )
      .returning();

    if (claim) {
      // Detached self-healing refill check — kept off the invoice-create
      // critical path (mirrors allocateForInvoice).
      void (async () => {
        try {
          const available = await countAvailable(deps, chainId);
          if (available < REFILL_TRIGGER_THRESHOLD) scheduleRefill(deps, chainId);
        } catch (err) {
          deps.logger.warn("monero-pool.refill_check.failed", { chainId, error: errMsg(err) });
        }
      })();
      return {
        id: claim.id,
        address: claim.address as Address,
        addressIndex: claim.addressIndex
      };
    }
    // CAS miss or empty pool — loop and let the retry budget surface
    // PoolExhaustedError if it's genuinely empty.
  }
  scheduleRefill(deps, chainId);
  throw new PoolExhaustedError("monero");
}

// Release all Monero pool rows tied to `invoiceId` back to 'available'. Called
// on invoice terminal (completed/expired/canceled) via the event subscriber and
// from the create-failure compensating path. Bumps total_allocations and stamps
// the cooldown floor.
export async function releaseMoneroFromInvoice(
  deps: AppDeps,
  invoiceId: string,
  options: { merchantId?: string } = {}
): Promise<void> {
  const now = deps.clock.now().getTime();
  const cooldownUntil = await resolveMoneroCooldownUntil(deps, options.merchantId, now);
  await deps.db
    .update(moneroSubaddressPool)
    .set({
      status: "available",
      allocatedToInvoiceId: null,
      allocatedAt: null,
      totalAllocations: sql`${moneroSubaddressPool.totalAllocations} + 1`,
      lastReleasedAt: now,
      cooldownUntil,
      lastReleasedByMerchantId: options.merchantId ?? null
    })
    .where(eq(moneroSubaddressPool.allocatedToInvoiceId, invoiceId));
}

// Cooldown deadline for a release: the configured Monero floor, raised (never
// lowered) by the merchant's `address_cooldown_seconds`. Always returns a
// positive deadline unless the operator explicitly set the floor to 0 and the
// merchant cooldown is also 0.
async function resolveMoneroCooldownUntil(
  deps: AppDeps,
  merchantId: string | undefined,
  now: number
): Promise<number> {
  const floorMs = moneroCooldownFloorMs(deps);
  let merchantMs = 0;
  if (merchantId) {
    const [row] = await deps.db
      .select({ seconds: merchants.addressCooldownSeconds })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    merchantMs = Math.max(0, row?.seconds ?? 0) * 1000;
  }
  return now + Math.max(floorMs, merchantMs);
}

function moneroCooldownFloorMs(deps: AppDeps): number {
  const seconds = deps.moneroPoolCooldownSeconds ?? DEFAULT_MONERO_POOL_COOLDOWN_SECONDS;
  return Math.max(0, seconds) * 1000;
}

// Derive `count` new subaddresses for `chainId`, insert as 'available'.
// Idempotent under contention via a cache mutex; a racing refill is a no-op.
// Returns the number of rows inserted.
export async function refillMoneroPool(
  deps: AppDeps,
  chainId: ChainId,
  count: number
): Promise<number> {
  if (count <= 0) return 0;
  const lockKey = `monero-pool:refill-lock:${chainId}`;
  const acquired = await deps.cache.putIfAbsent(lockKey, "1", { ttlSeconds: REFILL_LOCK_TTL_SECONDS });
  if (!acquired) return 0;
  try {
    const adapter = moneroAdapterFor(deps, chainId);
    const now = deps.clock.now().getTime();

    // Start index: above the pool's current max AND the legacy counter's
    // high-water mark, and >= 1 (index 0 is the operator's primary address).
    // This guarantees a freshly-pooled subaddress never equals one the legacy
    // per-invoice allocator already issued to a live/historical invoice.
    const [maxRow] = await deps.db
      .select({ maxIdx: max(moneroSubaddressPool.addressIndex) })
      .from(moneroSubaddressPool)
      .where(eq(moneroSubaddressPool.chainId, chainId));
    const [counterRow] = await deps.db
      .select({ nextIndex: moneroSubaddressCounters.nextIndex })
      .from(moneroSubaddressCounters)
      .where(eq(moneroSubaddressCounters.chainId, chainId));
    const startIdx = Math.max(1, (maxRow?.maxIdx ?? 0) + 1, counterRow?.nextIndex ?? 1);

    type DerivedRow = { id: string; address: string; index: number };
    const derived: DerivedRow[] = [];
    for (let i = 0; i < count; i += 1) {
      const index = startIdx + i;
      const address = deriveSubaddress({
        network: adapter.moneroNetwork,
        viewKeySecret: adapter.moneroViewKey,
        primarySpendPub: adapter.moneroPrimarySpendPub,
        account: 0,
        index
      });
      derived.push({ id: globalThis.crypto.randomUUID(), address, index });
    }

    const inserts = derived.map((d) =>
      deps.db.insert(moneroSubaddressPool).values({
        id: d.id,
        chainId,
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

    // Advance the legacy counter past the derived batch so it stays the single
    // high-water mark for "highest index ever derived on this chain" — even a
    // stray legacy allocateMoneroSubaddress call then gets a non-colliding
    // index. MAX() guards the (mutex-prevented) concurrent case defensively.
    const newNext = startIdx + derived.length;
    await deps.db
      .insert(moneroSubaddressCounters)
      .values({ chainId, nextIndex: newNext, updatedAt: now })
      .onConflictDoUpdate({
        target: moneroSubaddressCounters.chainId,
        set: {
          nextIndex: sql`MAX(${moneroSubaddressCounters.nextIndex}, ${newNext})`,
          updatedAt: now
        }
      });

    // Visibility (not a hard cap): a large live set means churn is outrunning
    // reuse. Surface a tuning hint rather than silently growing forever.
    const poolSize = await countPool(deps, chainId);
    if (poolSize >= POOL_SIZE_SOFT_WARN) {
      deps.logger.warn("monero-pool: live set is large — churn may be outrunning reuse", {
        chainId,
        size: poolSize,
        hint: "raise MONERO_POOL_INITIAL_SIZE or lower MONERO_POOL_COOLDOWN_SECONDS"
      });
    }

    deps.logger.info("monero pool refilled", { chainId, count: derived.length, startIndex: startIdx });
    return derived.length;
  } catch (err) {
    deps.logger.error("monero pool refill failed", { chainId, error: errMsg(err) });
    throw err;
  } finally {
    await deps.cache.delete(lockKey);
  }
}

export interface InitializeMoneroPoolResult {
  chainId: number;
  outcome: "topped-up" | "already-sufficient";
  priorCount: number;
  added: number;
}

// Idempotent boot/admin seeding: top each wired Monero chain's pool up to
// `initialSize`. Safe to call on every boot — a no-op once the pool is full.
export async function initializeMoneroPool(
  deps: AppDeps,
  opts: { initialSize?: number } = {}
): Promise<readonly InitializeMoneroPoolResult[]> {
  const initialSize =
    opts.initialSize ?? deps.moneroPoolInitialSize ?? DEFAULT_MONERO_POOL_INITIAL_SIZE;
  const results: InitializeMoneroPoolResult[] = [];
  const moneroChainIds = deps.chains
    .filter(isMoneroChainAdapter)
    .flatMap((a) => a.supportedChainIds);
  for (const chainId of moneroChainIds) {
    const prior = await countPool(deps, chainId);
    const needed = Math.max(0, initialSize - prior);
    if (needed === 0) {
      results.push({ chainId, outcome: "already-sufficient", priorCount: prior, added: 0 });
      continue;
    }
    const added = await refillMoneroPool(deps, chainId, needed);
    results.push({ chainId, outcome: "topped-up", priorCount: prior, added });
  }
  return results;
}

export interface ReconcileOrphanedMoneroAllocationsResult {
  released: number;
}

// Defense-in-depth sweeper mirroring reconcileOrphanedAllocations: release any
// 'allocated' row past the grace window whose invoice is terminal/missing.
// Unlike the shared reconciler (which releases with cooldownUntil=null), this
// stamps the Monero cooldown floor so the reuse-safety window isn't lost when
// the sweeper, rather than the event bus, frees the row.
export async function reconcileOrphanedMoneroAllocations(
  deps: AppDeps
): Promise<ReconcileOrphanedMoneroAllocationsResult> {
  const now = deps.clock.now().getTime();
  const cutoff = now - ORPHAN_GRACE_MS;

  const activeRows = await deps.db
    .select({ id: invoices.id })
    .from(invoices)
    .where(inArray(invoices.status, ["pending", "processing"]))
    .limit(RECONCILE_ACTIVE_INVOICE_FETCH_LIMIT);
  const activeIds = activeRows.map((r) => r.id);

  const orphanIdMatch =
    activeIds.length === 0
      ? sql`1=1`
      : notInArray(moneroSubaddressPool.allocatedToInvoiceId, activeIds);

  const cooldownUntil = now + moneroCooldownFloorMs(deps);

  const updated = await deps.db
    .update(moneroSubaddressPool)
    .set({
      status: "available",
      allocatedToInvoiceId: null,
      allocatedAt: null,
      totalAllocations: sql`${moneroSubaddressPool.totalAllocations} + 1`,
      lastReleasedAt: now,
      cooldownUntil,
      lastReleasedByMerchantId: null
    })
    .where(
      and(
        eq(moneroSubaddressPool.status, "allocated"),
        lt(moneroSubaddressPool.allocatedAt, cutoff),
        or(isNull(moneroSubaddressPool.allocatedToInvoiceId), orphanIdMatch)
      )
    )
    .returning({ id: moneroSubaddressPool.id });

  if (updated.length > 0) {
    deps.logger.warn("monero pool reconciled orphaned allocations", { released: updated.length });
  }
  return { released: updated.length };
}

// Event-bus subscriber: release Monero pool rows when the owning invoice reaches
// a terminal state. Coexists with the shared registerPoolReleaseHandler — the
// two touch disjoint tables, so for any invoice at most one matches rows and the
// other is a harmless 0-row UPDATE.
export function registerMoneroPoolReleaseHandler(deps: AppDeps): () => void {
  const handler = async (event: { invoice: { id: string; merchantId: string } }): Promise<void> => {
    try {
      await releaseMoneroFromInvoice(deps, event.invoice.id, { merchantId: event.invoice.merchantId });
    } catch (err) {
      deps.logger.error("monero pool release failed on invoice terminal transition", {
        invoiceId: event.invoice.id,
        error: errMsg(err)
      });
    }
  };
  const unsubscribers = [
    deps.events.subscribe("invoice.completed", handler),
    deps.events.subscribe("invoice.expired", handler),
    deps.events.subscribe("invoice.canceled", handler)
  ];
  return () => {
    for (const u of unsubscribers) u();
  };
}

export interface MoneroPoolAddressInfo {
  cooldownUntil: number | null;
  totalAllocations: number;
  allocatedToInvoiceId: string | null;
}

// Look up the pool row for (chainId, address). Returns null for addresses not
// in the pool (e.g. pre-migration counter-minted subaddresses) — callers treat
// "no row" as "not owned by the pool lifecycle".
export async function getMoneroPoolAddress(
  deps: AppDeps,
  chainId: ChainId,
  address: string
): Promise<MoneroPoolAddressInfo | null> {
  const [row] = await deps.db
    .select({
      cooldownUntil: moneroSubaddressPool.cooldownUntil,
      totalAllocations: moneroSubaddressPool.totalAllocations,
      allocatedToInvoiceId: moneroSubaddressPool.allocatedToInvoiceId
    })
    .from(moneroSubaddressPool)
    .where(and(eq(moneroSubaddressPool.chainId, chainId), eq(moneroSubaddressPool.address, address)))
    .limit(1);
  return row ?? null;
}

// True iff the Monero pool row for (chainId, address) is still in cooldown.
// Consulted by the ingest matcher to gate late-payment attribution.
export async function isMoneroAddressInCooldown(
  deps: AppDeps,
  chainId: ChainId,
  address: string
): Promise<boolean> {
  const info = await getMoneroPoolAddress(deps, chainId, address);
  if (!info || info.cooldownUntil === null) return false;
  return info.cooldownUntil > deps.clock.now().getTime();
}

export interface MoneroPoolChainStats {
  chainId: number;
  available: number;
  allocated: number;
  quarantined: number;
  total: number;
  highestIndex: number | null;
}

export async function getMoneroPoolStats(deps: AppDeps): Promise<readonly MoneroPoolChainStats[]> {
  const rows = await deps.db
    .select({
      chainId: moneroSubaddressPool.chainId,
      status: moneroSubaddressPool.status,
      cnt: count(),
      maxIdx: max(moneroSubaddressPool.addressIndex)
    })
    .from(moneroSubaddressPool)
    .groupBy(moneroSubaddressPool.chainId, moneroSubaddressPool.status);

  const byChain = new Map<number, MoneroPoolChainStats>();
  for (const row of rows) {
    const agg = byChain.get(row.chainId) ?? {
      chainId: row.chainId,
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
    byChain.set(row.chainId, agg);
  }
  return Array.from(byChain.values()).sort((a, b) => a.chainId - b.chainId);
}

// ---- Internals ----

function moneroAdapterFor(deps: AppDeps, chainId: ChainId): MoneroChainAdapter {
  const adapter = findChainAdapter(deps, chainId);
  if (!isMoneroChainAdapter(adapter)) {
    throw new Error(`monero-pool: chainId ${chainId} is not served by a Monero adapter`);
  }
  return adapter;
}

async function countPool(deps: AppDeps, chainId: ChainId): Promise<number> {
  const [row] = await deps.db
    .select({ cnt: count() })
    .from(moneroSubaddressPool)
    .where(eq(moneroSubaddressPool.chainId, chainId));
  return row?.cnt ?? 0;
}

async function countAvailable(deps: AppDeps, chainId: ChainId): Promise<number> {
  const [row] = await deps.db
    .select({ cnt: count() })
    .from(moneroSubaddressPool)
    .where(and(eq(moneroSubaddressPool.chainId, chainId), eq(moneroSubaddressPool.status, "available")));
  return row?.cnt ?? 0;
}

function scheduleRefill(deps: AppDeps, chainId: ChainId): void {
  deps.jobs.defer(
    async () => {
      try {
        await refillMoneroPool(deps, chainId, DEFAULT_REFILL_BATCH);
      } catch (err) {
        // refillMoneroPool already logs — swallow so defer doesn't double-report.
        void err;
      }
    },
    { name: `monero-pool-refill:${chainId}` }
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
