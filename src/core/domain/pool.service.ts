import { and, asc, count, eq, inArray, isNotNull, isNull, lt, lte, max, notInArray, or, sql } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { PoolExhaustedError } from "../errors.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import type { Address, ChainFamily, ChainId } from "../types/chain.js";
import type { PoolAddress, PoolFamilyStats } from "../types/pool.js";
import { TOKEN_REGISTRY } from "../types/token-registry.js";
import { addressPool, invoices, merchants, payoutReservations, transactions } from "../../db/schema.js";
import {
  closeAllocationsByInvoice,
  closeAllocationsByPoolIds,
  recordAllocationOpen
} from "./address-allocation-history.js";
import { computeSpendable, computeSpendableBatch } from "./balance-snapshot.service.js";

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
//   quarantine → two flavors sharing status='quarantined':
//              - operator disable (disabled_at set) — manual park intent.
//              - auto-retire (retired_at set, disabled_at NULL) — the hourly
//                shrinkIdlePools sweep parks idle zero-balance rows so a
//                demand spike doesn't permanently inflate the watched set.
//   retire/dereg → retired_at is the watcher-deregistration marker:
//              set ⟺ a pool.address.quarantined event was published (Alchemy
//              tracker enqueues per-chain `remove` rows) and no re-add has
//              been published since. EVERY path returning a row to service
//              (refill reactivation, under-pressure borrow, operator enable,
//              stray-funds rescan) clears retired_at and re-publishes
//              pool.address.created so the watchers re-register.
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

// ---- Auto-shrink defaults (see shrinkIdlePools) ----

// Retire an idle 'available' row after this many hours without an allocation.
// Overridable via deps.poolRetireIdleHours (env POOL_RETIRE_IDLE_HOURS);
// 0 disables auto-shrink entirely. 24h comfortably clears every late-payment
// watch window (1h expired-poll, 24h processing grace, merchant cooldown is
// gated separately below).
const DEFAULT_POOL_RETIRE_IDLE_HOURS = 24;

// Never shrink a family below this many 'available' rows — the standing
// buffer that absorbs normal traffic without borrow/refill churn. Must stay
// above REFILL_TRIGGER_THRESHOLD or every allocation near the floor would
// kick a (reactivating) refill. Overridable via deps.poolMinAvailable
// (env POOL_MIN_AVAILABLE).
const DEFAULT_POOL_MIN_AVAILABLE = 5;

// Cadence of the shrink sweep, enforced with a cache-TTL throttle so the
// per-minute cron tick only pays a putIfAbsent the other 59 minutes.
const POOL_SHRINK_RUN_INTERVAL_SECONDS = 60 * 60;

// Cap retirements per run so a huge post-spike backlog can't blow the cron
// CPU budget. The hourly cadence drains any realistic backlog within a day.
const POOL_SHRINK_MAX_PER_RUN = 200;

// Daily RPC safety-net rescan over retired (deregistered) rows — a stray
// deposit to an unwatched address must never go dark. Overridable via
// deps.poolRetiredRescanHours (env POOL_RETIRED_RESCAN_HOURS); 0 disables.
const DEFAULT_POOL_RETIRED_RESCAN_HOURS = 24;

// Hard budget of getAccountBalances RPC calls per rescan run. This is the
// real cap (not an address count): one EVM address costs one probe per
// active chain, and Workers has a per-invocation subrequest budget the whole
// cron tick shares — the repo convention is ~200 external calls per sweep.
// Rows beyond the budget are NOT starved: the cursor below resumes where
// this run stopped and wraps at the end of the set.
const RESCAN_MAX_RPC_PROBES_PER_RUN = 200;

// Max rows fetched per run (upper bound on the cursor page; the probe
// budget is what actually limits work for multi-chain families).
const RESCAN_MAX_ADDRESSES_PER_RUN = 200;

// Rotation cursor so successive runs walk the ENTIRE retired set instead of
// re-probing the same oldest rows forever. Cleared when a run reaches the
// end of the set (wrap to start).
const RESCAN_CURSOR_CACHE_KEY = "pool:retired-rescan-cursor";
const RESCAN_CURSOR_TTL_SECONDS = 14 * 24 * 60 * 60;

interface RescanCursor {
  retiredAt: number;
  id: string;
}

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
    // Count only ACTIVE rows (retired_at NULL): refill satisfies `needed` by
    // reactivating retired rows before minting, which adds zero total rows —
    // counting retired rows as "present" would report topped-up while active
    // capacity stayed below the target. Retired rows count as capacity only
    // once reactivation brings them back.
    const prior = await countActivePool(deps, family);
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
    // Single-statement allocate: pick the cheapest available row via
    // subquery and CAS-update it in one round-trip. SQLite's UPDATE…WHERE
    // id IN (SELECT … LIMIT 1) is atomic — the subquery runs against the
    // pre-update snapshot and the WHERE re-checks status='available'
    // against the same snapshot, so two concurrent allocators can't both
    // land on the same row. The retry loop covers the legitimate CAS-miss
    // case (two parallel allocators both saw the same candidate before
    // either ran the UPDATE).
    //
    // Ordering rationale:
    //   1. totalAllocations ASC — never-used rows (count=0) win first.
    //   2. lastReleasedAt ASC NULLS FIRST — among rows with equal use count,
    //      longest-dormant wins; just-released rows go to the back. Gives a
    //      late payment to a recently expired invoice the longest possible
    //      window to land on the address that was tied to it. SQLite's
    //      default ASC already places NULLs first.
    //   3. addressIndex ASC — deterministic final tiebreak, oldest derivation
    //      first.
    //
    // Pre-fix this was SELECT then UPDATE — two RTTs per allocation; on a
    // Turso edge replica that doubled the per-family cost in invoice-create.
    const candidateSubquery = deps.db
      .select({ id: addressPool.id })
      .from(addressPool)
      .where(
        and(
          eq(addressPool.family, family),
          eq(addressPool.status, "available"),
          or(isNull(addressPool.cooldownUntil), lte(addressPool.cooldownUntil, now))
        )
      )
      .orderBy(
        asc(addressPool.totalAllocations),
        asc(addressPool.lastReleasedAt),
        asc(addressPool.addressIndex)
      )
      .limit(1);

    const [claim] = await deps.db
      .update(addressPool)
      .set({
        status: "allocated",
        allocatedToInvoiceId: invoiceId,
        allocatedAt: now,
        // Clear release-side metadata so the next release re-stamps it
        // with the new owner's cooldown window.
        cooldownUntil: null,
        lastReleasedByMerchantId: null
      })
      .where(
        and(
          inArray(addressPool.id, candidateSubquery),
          eq(addressPool.status, "available")
        )
      )
      .returning();

    if (claim) {
      // Open an ownership-history window stamped with the SAME `now` written
      // to address_pool.allocated_at above. This is the authoritative
      // allocation instant the re-ingest matcher needs (NOT the earlier
      // invoice_receive_addresses.created_at). Awaited so the window is
      // durable before the invoice row references this address.
      await recordAllocationOpen(deps, {
        family,
        address: claim.address,
        chainId: null,
        poolAddressId: claim.id,
        invoiceId,
        allocatedAt: now
      });
      // Post-allocation: check the available count and schedule a refill
      // when below the trigger. This is what keeps the pool self-healing
      // without any cron support.
      //
      // Detached on purpose: the count + scheduleRefill chain is a self-
      // healing background concern, not part of the merchant's
      // invoice-create critical path. Awaiting it here added a per-family
      // SELECT count(*) to every invoice creation — on a Turso edge replica
      // that's another 50–200 ms × N families. Fire-and-forget; errors
      // log but don't propagate.
      void (async () => {
        try {
          const available = await countAvailable(deps, family);
          if (available < REFILL_TRIGGER_THRESHOLD) {
            scheduleRefill(deps, family);
          }
        } catch (err) {
          deps.logger.warn("pool.refill_check.failed", {
            family,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      })();
      return drizzleRowToPoolAddress(claim);
    }
    // claim === undefined: either the subquery found no candidate (pool
    // empty / all rows in cooldown) or another allocator beat us to it
    // (CAS-miss). Both manifest the same way after collapsing SELECT+
    // UPDATE — distinguishing them would require an extra read, which is
    // exactly the cost we just removed. Loop and let the retry budget
    // surface PoolExhaustedError if it really is empty.
  }
  // No 'available' rows after the retry budget. Before refilling (which mints
  // NEW addresses — grows the pool, and on Tron re-pays ~1 TRX activation per
  // fresh account), try to BORROW a parked address back into rotation:
  // auto-retired rows first (they were parked purely as a cost measure — a
  // spike is exactly when we want them back), operator-disabled rows last
  // (that park is explicit intent, honored right up until the pool would
  // otherwise be exhausted). A borrowed disabled row keeps `disabledAt` set,
  // so `releaseFromInvoice` re-parks it once the invoice ends — the pool
  // self-balances back down without manual intervention.
  //
  // SELECT-then-CAS (two round-trips) instead of the hot path's collapsed
  // form: we need the row's PRIOR retired_at to know whether its watcher
  // registration was removed and must be re-published. Borrow only fires
  // under exhaustion, so the extra read is off the common path.
  for (let attempt = 0; attempt < ALLOCATE_RETRY_LIMIT; attempt += 1) {
    const [parked] = await deps.db
      .select({ id: addressPool.id, retiredAt: addressPool.retiredAt })
      .from(addressPool)
      .where(
        and(
          eq(addressPool.family, family),
          eq(addressPool.status, "quarantined"),
          or(isNull(addressPool.cooldownUntil), lte(addressPool.cooldownUntil, now))
        )
      )
      .orderBy(
        // Retired-first: rows with disabled_at NULL (auto-retired) sort before
        // operator-disabled ones.
        sql`(${addressPool.disabledAt} IS NULL) DESC`,
        asc(addressPool.totalAllocations),
        asc(addressPool.lastReleasedAt),
        asc(addressPool.addressIndex)
      )
      .limit(1);
    if (!parked) break;

    const [borrowed] = await deps.db
      .update(addressPool)
      .set({
        status: "allocated",
        allocatedToInvoiceId: invoiceId,
        allocatedAt: now,
        cooldownUntil: null,
        lastReleasedByMerchantId: null,
        // Back in service — re-watched below when it had been deregistered.
        retiredAt: null
        // disabledAt intentionally preserved — release re-parks this row.
      })
      .where(
        and(
          eq(addressPool.id, parked.id),
          eq(addressPool.status, "quarantined"),
          // CAS on the retired-state the publish decision below is based on:
          // shrink pass 2 stamps retired_at WITHOUT touching status, so a
          // status-only guard would let a deregistration slip in between the
          // SELECT and this UPDATE and the re-add publish would be skipped
          // for an invoice-bound address. A miss just loops and re-reads.
          parked.retiredAt === null ? isNull(addressPool.retiredAt) : isNotNull(addressPool.retiredAt)
        )
      )
      .returning();

    if (borrowed) {
      await recordAllocationOpen(deps, {
        family,
        address: borrowed.address,
        chainId: null,
        poolAddressId: borrowed.id,
        invoiceId,
        allocatedAt: now
      });
      if (parked.retiredAt !== null) {
        // The row had been deregistered from push watchers — re-register it
        // and kick an immediate sync so the detection gap for the invoice we
        // just bound is seconds, not a full cron tick. (publish awaits the
        // tracker's enqueue, so the kick can't outrun the pending `add` row.)
        await publishPoolAddressCreated(deps, {
          poolAddressId: borrowed.id,
          family,
          address: borrowed.address,
          addressIndex: borrowed.addressIndex,
          atMs: now
        });
        kickAlchemySync(deps);
      }
      deps.logger.info("pool.borrowed_parked_under_pressure", {
        family,
        address: borrowed.address,
        invoiceId,
        wasRetired: parked.retiredAt !== null
      });
      // Still kick a refill so the next request finds a true 'available' row
      // and we stop borrowing parked addresses. Refill reactivates remaining
      // retired rows before minting, so this doesn't regrow the pool while
      // parked capacity remains.
      scheduleRefill(deps, family);
      return drizzleRowToPoolAddress(borrowed);
    }
  }

  // Pool truly exhausted (no available AND no borrowable parked rows, or N
  // concurrent allocators all lost the race). Schedule a background refill
  // before throwing so the next request has something to allocate.
  scheduleRefill(deps, family);
  throw new PoolExhaustedError(family);
}

// Release all pool rows tied to `invoiceId` back to 'available'. Called when
// an invoice reaches a terminal state (confirmed/expired/canceled). Bumps
// total_allocations on each released row so the fair-rotation ordering moves
// it to the back of the queue. When `merchantId` is provided, the merchant's
// `address_cooldown_seconds` is read and stamped onto each released row as
// `cooldown_until = now + cooldown_seconds * 1000`, alongside
// `last_released_by_merchant_id`. Late payments arriving during the cooldown
// land as orphans tied (by inference) to that merchant for admin attribution.
export async function releaseFromInvoice(
  deps: AppDeps,
  invoiceId: string,
  options: { merchantId?: string } = {}
): Promise<void> {
  const now = deps.clock.now().getTime();
  const cooldownUntil = await resolveCooldownUntil(deps, options.merchantId, now);
  await deps.db
    .update(addressPool)
    .set({
      // Re-park operator-disabled rows (disabledAt set) instead of returning
      // them to 'available' — keeps the pool self-balancing after an
      // under-pressure borrow. Non-disabled rows release as usual.
      status: sql`CASE WHEN ${addressPool.disabledAt} IS NOT NULL THEN 'quarantined' ELSE 'available' END`,
      allocatedToInvoiceId: null,
      allocatedAt: null,
      totalAllocations: sql`${addressPool.totalAllocations} + 1`,
      lastReleasedAt: now,
      cooldownUntil,
      lastReleasedByMerchantId: options.merchantId ?? null
    })
    .where(eq(addressPool.allocatedToInvoiceId, invoiceId));
  // Close the ownership-history window(s) with the SAME `now` written to
  // address_pool.last_released_at above. After this the address is owned by
  // NO invoice until the next allocate — a transfer landing in that gap
  // matches no window and correctly orphans.
  await closeAllocationsByInvoice(deps, invoiceId, now);
}

// Lookup `merchant.address_cooldown_seconds` and project to an absolute
// deadline. Returns null when no merchant context is supplied (test paths,
// compensating-release pre-commit) or when the merchant disables cooldown.
async function resolveCooldownUntil(
  deps: AppDeps,
  merchantId: string | undefined,
  now: number
): Promise<number | null> {
  if (!merchantId) return null;
  const [row] = await deps.db
    .select({ seconds: merchants.addressCooldownSeconds })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  const seconds = row?.seconds ?? 0;
  if (seconds <= 0) return null;
  return now + seconds * 1000;
}

// Grace period before an `allocated` row is treated as orphaned. Long enough
// for the in-flight create-invoice flow to finish (allocate → snapshot rates
// → encrypt → batch insert ≈ <1s typical, <5s worst case on a cold connection)
// without racing the reconciler. A row whose allocated_at is younger than this
// is left alone even if its invoice row isn't visible yet — the writer might
// just not have committed.
const ORPHAN_GRACE_MS = 60 * 1000;

// How many in-flight invoice IDs to inline into the NOT IN clause for the
// orphan-check. The reconciler's WHERE matches `allocated` rows whose
// `allocated_to_invoice_id` is NULL, points to a missing invoice row, or
// points to an invoice in a terminal state. We list active invoice IDs
// instead of joining because Turso/SQLite handles a small IN-list cheaply
// and it lets the WHERE be a single, transparent UPDATE.
const RECONCILE_ACTIVE_INVOICE_FETCH_LIMIT = 10_000;

export interface ReconcileOrphanedAllocationsResult {
  released: number;
}

// Defense-in-depth sweeper for the address pool. The event-bus release path
// (registerPoolReleaseHandler below) is the primary mechanism for returning
// allocated rows to rotation, but it depends on:
//   1. The compensating release in invoice.service catching every create
//      failure (we widened it; still possible for an exotic path to escape).
//   2. The invoice.expired / .confirmed / .canceled events actually being
//      published and delivered to the in-memory subscriber (process crash
//      between publish and subscriber callback drops the release).
// This job runs on the cron tick and releases any 'allocated' row that is
// almost certainly leaked: no invoice_id, an invoice_id with no matching
// invoice row, or an invoice already in a terminal state. It only releases
// rows older than ORPHAN_GRACE_MS to avoid racing in-flight invoice creates.
export async function reconcileOrphanedAllocations(
  deps: AppDeps
): Promise<ReconcileOrphanedAllocationsResult> {
  const now = deps.clock.now().getTime();
  const cutoff = now - ORPHAN_GRACE_MS;

  // Snapshot active invoice IDs (any non-terminal status). We exclude these
  // from the release set; everything else with status='allocated' past the
  // grace window is fair game.
  const activeRows = await deps.db
    .select({ id: invoices.id })
    .from(invoices)
    // Non-terminal lifecycle stages — pool addresses tied to these stay
    // pinned to their invoice. `completed` releases on transition (sweeper
    // doesn't need to release them); `expired`/`canceled` are terminal.
    .where(inArray(invoices.status, ["pending", "processing"]))
    .limit(RECONCILE_ACTIVE_INVOICE_FETCH_LIMIT);
  const activeIds = activeRows.map((r) => r.id);

  // Three releasable cases (combined with OR):
  //   - allocated_to_invoice_id IS NULL                (broken state)
  //   - allocated_to_invoice_id NOT IN (active ids)    (terminal or missing)
  //   - allocated_at older than grace                  (always required)
  // The grace clause guards against releasing a row whose invoice row is
  // mid-insert: even if the allocated_to_invoice_id isn't found in `invoices`
  // yet, it might be 200ms from being committed.
  const orphanIdMatch =
    activeIds.length === 0
      ? // No active invoices at all → every non-NULL invoice_id is releasable
        // (its invoice is terminal or gone).
        sql`1=1`
      : notInArray(addressPool.allocatedToInvoiceId, activeIds);

  const updated = await deps.db
    .update(addressPool)
    .set({
      // Re-park operator-disabled rows so a leaked borrow returns to parked,
      // not to general rotation (mirrors releaseFromInvoice).
      status: sql`CASE WHEN ${addressPool.disabledAt} IS NOT NULL THEN 'quarantined' ELSE 'available' END`,
      allocatedToInvoiceId: null,
      allocatedAt: null,
      totalAllocations: sql`${addressPool.totalAllocations} + 1`,
      lastReleasedAt: now,
      // The reconciler doesn't have invoice→merchant context here; releasing
      // without a cooldown stamp matches existing behavior, and merchants
      // who depend on cooldown still get it on the normal event-bus path.
      cooldownUntil: null,
      lastReleasedByMerchantId: null
    })
    .where(
      and(
        eq(addressPool.status, "allocated"),
        lt(addressPool.allocatedAt, cutoff),
        or(isNull(addressPool.allocatedToInvoiceId), orphanIdMatch)
      )
    )
    .returning({ id: addressPool.id });

  if (updated.length > 0) {
    // Close the leaked rows' ownership-history windows too. Keyed by pool row
    // id because a leaked row may carry a NULL allocated_to_invoice_id.
    await closeAllocationsByPoolIds(deps, updated.map((u) => u.id), now);
    deps.logger.warn("pool reconciled orphaned allocations", { released: updated.length });
  }
  return { released: updated.length };
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
    // 'available' OR 'quarantined': a demotion can arrive up to the 24h reorg
    // recheck window after release, by which time the shrink sweep may have
    // already retired the row. A retired row is still THE address the demoted
    // invoice's payer used — re-claim it and re-register its watchers.
    const updated = await deps.db
      .update(addressPool)
      .set({
        status: "allocated",
        allocatedToInvoiceId: invoiceId,
        allocatedAt: now,
        cooldownUntil: null,
        lastReleasedByMerchantId: null,
        retiredAt: null
      })
      .where(
        and(
          eq(addressPool.address, address),
          inArray(addressPool.status, ["available", "quarantined"])
        )
      )
      .returning({
        id: addressPool.id,
        family: addressPool.family,
        address: addressPool.address,
        addressIndex: addressPool.addressIndex
      });
    if (updated.length > 0) {
      reacquired += 1;
      // Reorg re-claim re-opens ownership for this invoice: append a fresh
      // window. The prior window was closed at the earlier release, so a
      // transfer in the intervening gap still orphans correctly.
      const row = updated[0]!;
      await recordAllocationOpen(deps, {
        family: row.family,
        address: row.address,
        chainId: null,
        poolAddressId: row.id,
        invoiceId,
        allocatedAt: now
      });
      // Re-publish the watcher registration unconditionally: RETURNING gives
      // post-update state, so we can't see whether the row had been retired
      // (deregistered). A duplicate `add` for a still-registered address is
      // harmless (sweep dedupes, Alchemy add is idempotent) and reorg
      // demotions are rare.
      await publishPoolAddressCreated(deps, {
        poolAddressId: row.id,
        family: row.family,
        address: row.address,
        addressIndex: row.addressIndex,
        atMs: now
      });
      kickAlchemySync(deps);
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

// Grow the family's ACTIVE pool by `count`: first REACTIVATE auto-retired
// rows (cheapest — the address exists, and on Tron its account activation is
// already paid), then derive new HD addresses for the remainder and insert
// as 'available'. Emits pool.address.created per row either way so the
// Alchemy tracker (re-)registers the watchers. Idempotent under contention
// via the cache mutex — if another refill is mid-flight, this call is a
// no-op and returns 0. Returns the number of rows brought into service.
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
    const now = deps.clock.now().getTime();

    // Reactivation-first: pull back the most-recently-retired rows (their
    // watcher `remove` may still be pending, so the re-`add` merges cleanly
    // in the sync queue). Operator-disabled rows are NOT touched — that park
    // is explicit intent, honored except via the exhaustion borrow path.
    const reactivateSubquery = deps.db
      .select({ id: addressPool.id })
      .from(addressPool)
      .where(
        and(
          eq(addressPool.family, family),
          eq(addressPool.status, "quarantined"),
          isNotNull(addressPool.retiredAt),
          isNull(addressPool.disabledAt)
        )
      )
      .orderBy(sql`${addressPool.retiredAt} DESC`)
      .limit(count);
    const reactivated = await deps.db
      .update(addressPool)
      .set({
        status: "available",
        retiredAt: null,
        // Fresh idle reference: without it a reactivated-but-unallocated row
        // keeps its ancient COALESCE(last_released_at, created_at) and the
        // very next hourly shrink re-retires it — a perpetual add/remove
        // watcher flap. Stamping "now" grants the same idle grace a released
        // row gets. (Also pushes it behind genuinely-dormant rows in the
        // allocator's fairness ordering — acceptable.)
        lastReleasedAt: now
      })
      .where(
        and(inArray(addressPool.id, reactivateSubquery), eq(addressPool.status, "quarantined"))
      )
      .returning({
        id: addressPool.id,
        address: addressPool.address,
        addressIndex: addressPool.addressIndex
      });
    for (const row of reactivated) {
      await publishPoolAddressCreated(deps, {
        poolAddressId: row.id,
        family,
        address: row.address,
        addressIndex: row.addressIndex,
        atMs: now
      });
    }

    const mintCount = count - reactivated.length;
    if (mintCount <= 0) {
      kickAlchemySync(deps);
      deps.logger.info("pool refilled", {
        family,
        count: reactivated.length,
        reactivated: reactivated.length,
        minted: 0
      });
      return reactivated.length;
    }

    const seed = deps.secrets.getRequired("MASTER_SEED");
    const [maxRow] = await deps.db
      .select({ maxIdx: max(addressPool.addressIndex) })
      .from(addressPool)
      .where(eq(addressPool.family, family));
    const startIdx = (maxRow?.maxIdx ?? -1) + 1;

    // Derive addresses synchronously (local crypto, no I/O), then insert in
    // one batch so a partial failure doesn't leave the pool in a half-built
    // state. The UNIQUE(family, address_index) constraint catches any race
    // where a second refill slipped through the cache mutex.
    type DerivedRow = { id: string; address: string; index: number };
    const derived: DerivedRow[] = [];
    for (let i = 0; i < mintCount; i += 1) {
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
    // tracker can enqueue per-chain `add` rows.
    for (const d of derived) {
      await publishPoolAddressCreated(deps, {
        poolAddressId: d.id,
        family,
        address: d.address,
        addressIndex: d.index,
        atMs: now
      });
    }
    kickAlchemySync(deps);

    deps.logger.info("pool refilled", {
      family,
      count: reactivated.length + derived.length,
      reactivated: reactivated.length,
      minted: derived.length,
      startIndex: startIdx
    });
    return reactivated.length + derived.length;
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
  const handler = async (event: { invoice: { id: string; merchantId: string } }): Promise<void> => {
    try {
      await releaseFromInvoice(deps, event.invoice.id, { merchantId: event.invoice.merchantId });
    } catch (err) {
      deps.logger.error("pool release failed on invoice terminal transition", {
        invoiceId: event.invoice.id,
        error: err instanceof Error ? err.message : String(err)
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
  // Auto-retired (watcher-deregistered) subset of 'quarantined' — surfaced so
  // operators can see the shrink sweep working.
  const retiredRows = await deps.db
    .select({ family: addressPool.family, cnt: count() })
    .from(addressPool)
    .where(isNotNull(addressPool.retiredAt))
    .groupBy(addressPool.family);
  const retiredByFamily = new Map(retiredRows.map((r) => [r.family, r.cnt]));

  const byFamily = new Map<ChainFamily, PoolFamilyStats>();
  for (const row of rows) {
    const agg = byFamily.get(row.family) ?? {
      family: row.family,
      available: 0,
      allocated: 0,
      quarantined: 0,
      retired: retiredByFamily.get(row.family) ?? 0,
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

// ---- Manual disable / enable (operator pool trimming) ----

// Thrown when an admin disable/enable targets an address that isn't in the
// family pool (or the family has no wired adapter to canonicalize against).
export class PoolAddressNotFoundError extends Error {
  constructor(family: ChainFamily, address: string) {
    super(`No ${family} pool address ${address}`);
    this.name = "PoolAddressNotFoundError";
  }
}

// Admin-facing view of a pool row's allocation/disable state.
export interface PoolAddressAdminView {
  readonly family: ChainFamily;
  readonly address: string;
  readonly addressIndex: number;
  readonly status: "available" | "allocated" | "quarantined";
  readonly disabledAt: number | null;
  // Auto-shrink watcher-deregistration marker; non-null = not push-watched.
  readonly retiredAt: number | null;
  readonly allocatedToInvoiceId: string | null;
}

function toAdminView(row: typeof addressPool.$inferSelect): PoolAddressAdminView {
  return {
    family: row.family as ChainFamily,
    address: row.address,
    addressIndex: row.addressIndex,
    status: row.status,
    disabledAt: row.disabledAt,
    retiredAt: row.retiredAt,
    allocatedToInvoiceId: row.allocatedToInvoiceId
  };
}

// Manually DISABLE (park) a pool address so the allocator stops handing it out
// during normal allocation. An idle ('available') row parks immediately; a
// currently-'allocated' row keeps serving its invoice and re-parks on release
// (via the disabledAt CASE in releaseFromInvoice). Idempotent — re-disabling
// preserves the original disable timestamp. Safe by construction: a parked row
// stays in the pool, is still swept by consolidation, and follows the same
// late-payment cooldown/orphan path as any released address; account-model
// keys are HD-derived so funds are always recoverable.
//
// Watcher deregistration is deliberately NOT immediate: the row may still be
// inside a late-payment cooldown (or serving an invoice, on the allocated
// branch). The hourly shrinkIdlePools pass 2 removes the watchers once the
// row has been parked + idle past the retire window.
export async function disablePoolAddress(
  deps: AppDeps,
  args: { family: ChainFamily; address: string }
): Promise<PoolAddressAdminView> {
  const adapter = findAdapterForFamily(deps, args.family);
  if (!adapter) throw new PoolAddressNotFoundError(args.family, args.address);
  const canonical = adapter.canonicalizeAddress(args.address);
  const now = deps.clock.now().getTime();

  const [updated] = await deps.db
    .update(addressPool)
    .set({
      // Preserve the original disable time on repeat calls.
      disabledAt: sql`COALESCE(${addressPool.disabledAt}, ${now})`,
      // Park immediately when idle; an allocated row keeps status until release.
      status: sql`CASE WHEN ${addressPool.status} = 'available' THEN 'quarantined' ELSE ${addressPool.status} END`
    })
    .where(and(eq(addressPool.family, args.family), eq(addressPool.address, canonical)))
    .returning();
  if (!updated) throw new PoolAddressNotFoundError(args.family, canonical);
  deps.logger.info("pool.address_disabled", {
    family: args.family,
    address: canonical,
    status: updated.status
  });
  return toAdminView(updated);
}

// Re-ENABLE a previously disabled pool address: clears the disable intent and
// un-parks an idle row (status quarantined → available). An allocated row will
// simply release to 'available' as normal now that disabledAt is cleared.
// If the row had been watcher-deregistered (retired_at set — either
// auto-retired or deregistered by the shrink sweep after an operator park),
// re-publishes the watcher registration. Idempotent.
export async function enablePoolAddress(
  deps: AppDeps,
  args: { family: ChainFamily; address: string }
): Promise<PoolAddressAdminView> {
  const adapter = findAdapterForFamily(deps, args.family);
  if (!adapter) throw new PoolAddressNotFoundError(args.family, args.address);
  const canonical = adapter.canonicalizeAddress(args.address);

  // Pre-read + CAS loop: RETURNING reflects post-update state, so the
  // re-publish decision must come from a pre-read — and the UPDATE must
  // assert that same retired-state so a shrink pass stamping retired_at
  // between the two can't produce a cleared-but-never-republished row.
  // Admin path — the extra reads are off any hot path.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [prior] = await deps.db
      .select({ retiredAt: addressPool.retiredAt })
      .from(addressPool)
      .where(and(eq(addressPool.family, args.family), eq(addressPool.address, canonical)))
      .limit(1);
    if (!prior) throw new PoolAddressNotFoundError(args.family, canonical);

    const [updated] = await deps.db
      .update(addressPool)
      .set({
        disabledAt: null,
        retiredAt: null,
        status: sql`CASE WHEN ${addressPool.status} = 'quarantined' THEN 'available' ELSE ${addressPool.status} END`
      })
      .where(
        and(
          eq(addressPool.family, args.family),
          eq(addressPool.address, canonical),
          prior.retiredAt === null ? isNull(addressPool.retiredAt) : isNotNull(addressPool.retiredAt)
        )
      )
      .returning();
    if (!updated) continue; // retired-state changed underneath us — re-read
    if (prior.retiredAt !== null) {
      await publishPoolAddressCreated(deps, {
        poolAddressId: updated.id,
        family: args.family,
        address: updated.address,
        addressIndex: updated.addressIndex,
        atMs: deps.clock.now().getTime()
      });
      kickAlchemySync(deps);
    }
    deps.logger.info("pool.address_enabled", {
      family: args.family,
      address: canonical,
      status: updated.status,
      rewatched: prior.retiredAt !== null
    });
    return toAdminView(updated);
  }
  throw new PoolAddressNotFoundError(args.family, canonical);
}

// List every disabled (parked or borrowed-under-pressure) pool address,
// optionally filtered by family. Lets operators see what they've trimmed.
export async function listDisabledAddresses(
  deps: AppDeps,
  family?: ChainFamily
): Promise<readonly PoolAddressAdminView[]> {
  const where = family
    ? and(isNotNull(addressPool.disabledAt), eq(addressPool.family, family))
    : isNotNull(addressPool.disabledAt);
  const rows = await deps.db
    .select()
    .from(addressPool)
    .where(where)
    .orderBy(asc(addressPool.family), asc(addressPool.addressIndex));
  return rows.map(toAdminView);
}

export interface ListPoolAddressesResult {
  readonly addresses: readonly PoolAddressAdminView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

// Paginated list of pool addresses with their allocation/disable state, so an
// operator can SEE the pool before deciding what to disable. Filter by family
// and/or status. Ordered by (family, addressIndex) for stable paging. To pick
// disable candidates, combine with GET /admin/balances (which addresses hold
// funds) — empty + 'available' rows are the safe ones to park.
export async function listPoolAddresses(
  deps: AppDeps,
  args: {
    family?: ChainFamily | undefined;
    status?: "available" | "allocated" | "quarantined" | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
): Promise<ListPoolAddressesResult> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;

  const conds = [];
  if (args.family) conds.push(eq(addressPool.family, args.family));
  if (args.status) conds.push(eq(addressPool.status, args.status));
  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const countQuery = deps.db.select({ cnt: count() }).from(addressPool);
  const [countRow] = whereClause ? await countQuery.where(whereClause) : await countQuery;

  const baseQuery = deps.db.select().from(addressPool);
  const filtered = whereClause ? baseQuery.where(whereClause) : baseQuery;
  const rows = await filtered
    .orderBy(asc(addressPool.family), asc(addressPool.addressIndex))
    .limit(limit)
    .offset(offset);

  return { addresses: rows.map(toAdminView), total: countRow?.cnt ?? 0, limit, offset };
}

// ---- Automatic pool shrink + retired-address safety rescan ----

export interface ShrinkIdlePoolsResult {
  // False when the run was skipped (feature off, or the hourly throttle
  // said another tick already ran it).
  ran: boolean;
  // 'available' rows retired this run (parked + watchers deregistered).
  retired: number;
  // Already-'quarantined' (operator-parked) rows whose watchers were
  // deregistered this run.
  deregisteredParked: number;
  // Idle candidates left active because the ledger shows a nonzero balance
  // or an in-flight reservation. Consolidation empties them; a later run
  // retires them.
  skippedWithBalance: number;
}

// Hourly cost-control sweep. A demand spike mints pool addresses; when demand
// drops the surplus sits 'available' forever — each one registered on every
// per-chain Alchemy webhook and touched by consolidation scans. This sweep
// retires the surplus:
//
//   Pass 1 — for each account-model family, 'available' rows that are
//     (a) beyond the POOL_MIN_AVAILABLE floor,
//     (b) idle past POOL_RETIRE_IDLE_HOURS (never allocated, or last
//         released, before the cutoff),
//     (c) past any merchant cooldown (the late-payment attribution window),
//     (d) not operator-disabled (that flavor is handled by pass 2), and
//     (e) provably zero-balance in the ledger with no active reservation
//     flip to 'quarantined' + retired_at, and publish
//     pool.address.quarantined → the Alchemy tracker enqueues per-chain
//     `remove` rows → the sync sweep PATCHes them off the webhooks.
//
//   Pass 2 — operator-parked 'quarantined' rows that never had their
//     watchers deregistered (retired_at NULL — including rows parked by
//     disablePoolAddress and borrow-returns re-parked by release) get the
//     same deregistration once equally idle. Balance is NOT gated here:
//     ledger funds on a parked row are already recorded, consolidation
//     discovers sources by ledger history, and the daily rescan alerts on
//     stray on-chain deposits.
//
// Retirement is reversible by design: refill reactivates retired rows
// before minting new indices, exhaustion borrows them retired-first, and a
// reorg reacquire or operator enable pulls a specific one back — every such
// path clears retired_at and re-publishes the watcher registration. Keys
// are HD-derived, so a retired address can never strand funds.
//
// Steady-state cost: one cache putIfAbsent per tick; on the hourly run with
// no idle surplus, one COUNT per family. The ledger verification only runs
// for rows actually about to retire (bounded by POOL_SHRINK_MAX_PER_RUN).
export async function shrinkIdlePools(
  deps: AppDeps,
  opts: { force?: boolean } = {}
): Promise<ShrinkIdlePoolsResult> {
  const skipped: ShrinkIdlePoolsResult = {
    ran: false,
    retired: 0,
    deregisteredParked: 0,
    skippedWithBalance: 0
  };
  const idleHours = deps.poolRetireIdleHours ?? DEFAULT_POOL_RETIRE_IDLE_HOURS;
  if (idleHours <= 0) return skipped;
  if (!opts.force) {
    const acquired = await deps.cache.putIfAbsent("pool:shrink-throttle", "1", {
      ttlSeconds: POOL_SHRINK_RUN_INTERVAL_SECONDS
    });
    if (!acquired) return skipped;
  }

  // Clamp: Workers/Deno/Vercel knob parsing accepts any non-negative number
  // (only the Node path goes through the zod schema), and a floor of 0 would
  // let the sweep retire the entire standing buffer.
  const minAvailable = Math.max(
    1,
    Math.floor(deps.poolMinAvailable ?? DEFAULT_POOL_MIN_AVAILABLE)
  );
  const now = deps.clock.now().getTime();
  const idleCutoff = now - idleHours * 60 * 60 * 1000;
  // Idle reference: last release, or creation for never-allocated rows.
  const idleExpr = sql`COALESCE(${addressPool.lastReleasedAt}, ${addressPool.createdAt})`;

  const result: ShrinkIdlePoolsResult = { ran: true, retired: 0, deregisteredParked: 0, skippedWithBalance: 0 };

  for (const [family, adapters] of accountModelAdaptersByFamily(deps)) {
    // Pass 1: retire the idle surplus above the floor.
    const availableCount = await countAvailable(deps, family);
    const excess = availableCount - minAvailable;
    if (excess > 0) {
      const candidates = await deps.db
        .select({ id: addressPool.id, address: addressPool.address })
        .from(addressPool)
        .where(
          and(
            eq(addressPool.family, family),
            eq(addressPool.status, "available"),
            isNull(addressPool.disabledAt),
            sql`${idleExpr} < ${idleCutoff}`,
            or(isNull(addressPool.cooldownUntil), lte(addressPool.cooldownUntil, now))
          )
        )
        // Longest-idle first — the floor keeps the most recently active rows.
        .orderBy(sql`${idleExpr} ASC`)
        .limit(Math.min(excess, POOL_SHRINK_MAX_PER_RUN));

      if (candidates.length > 0) {
        const zeroBalance = await filterZeroLedgerBalance(
          deps,
          adapters,
          candidates.map((c) => c.address)
        );
        result.skippedWithBalance += candidates.length - zeroBalance.size;
        let retireIds = candidates.filter((c) => zeroBalance.has(c.address)).map((c) => c.id);
        // Re-count right before retiring: the ledger check above is several
        // round-trips, and allocations in that window shrink the available
        // set — without this, a stale excess could retire down past the
        // floor (or two throttle-racing runs could retire the floor itself).
        const freshAvailable = await countAvailable(deps, family);
        retireIds = retireIds.slice(0, Math.max(0, freshAvailable - minAvailable));
        if (retireIds.length > 0) {
          // CAS re-asserts the FULL candidate predicate, not just status: a
          // row that cycled allocate→release during the ledger check is
          // 'available' again but carries a fresh lastReleasedAt (and
          // possibly a merchant cooldown) — it must survive this round, not
          // get deregistered inside its late-payment attribution window.
          const retiredRows = await deps.db
            .update(addressPool)
            .set({ status: "quarantined", retiredAt: now })
            .where(
              and(
                inArray(addressPool.id, retireIds),
                eq(addressPool.status, "available"),
                isNull(addressPool.disabledAt),
                sql`${idleExpr} < ${idleCutoff}`,
                or(isNull(addressPool.cooldownUntil), lte(addressPool.cooldownUntil, now))
              )
            )
            .returning({ id: addressPool.id, address: addressPool.address });
          for (const row of retiredRows) {
            await publishPoolAddressQuarantined(deps, {
              poolAddressId: row.id,
              family,
              address: row.address,
              atMs: now
            });
          }
          result.retired += retiredRows.length;
        }
      }
    }

    // Pass 2: deregister watchers for operator-parked rows (idle + past
    // cooldown) that are still registered.
    const parkedRows = await deps.db
      .update(addressPool)
      .set({ retiredAt: now })
      .where(
        and(
          eq(addressPool.family, family),
          eq(addressPool.status, "quarantined"),
          isNull(addressPool.retiredAt),
          sql`${idleExpr} < ${idleCutoff}`,
          or(isNull(addressPool.cooldownUntil), lte(addressPool.cooldownUntil, now))
        )
      )
      .returning({ id: addressPool.id, address: addressPool.address });
    for (const row of parkedRows) {
      await publishPoolAddressQuarantined(deps, {
        poolAddressId: row.id,
        family,
        address: row.address,
        atMs: now
      });
    }
    result.deregisteredParked += parkedRows.length;
  }

  if (result.retired > 0 || result.deregisteredParked > 0) {
    // Flush the `remove` rows promptly rather than waiting a full tick.
    kickAlchemySync(deps);
    deps.logger.info("pool.shrink", {
      retired: result.retired,
      deregisteredParked: result.deregisteredParked,
      skippedWithBalance: result.skippedWithBalance
    });
  }
  return result;
}

export interface RescanRetiredAddressesResult {
  ran: boolean;
  scanned: number;
  straysFound: number;
  errors: number;
}

// Daily RPC safety net for deregistered addresses. Once a row is retired its
// push watchers are removed and it is outside every invoice-scoped poll set —
// a stray deposit (someone re-paying a long-expired invoice URI) would land
// silently. This sweep walks retired rows, asks each chain for on-chain
// balances (RPC only — zero DB read amplification), and on any balance the
// ledger can't account for it: alerts loudly, un-retires the row, and
// re-registers its watchers so subsequent activity is seen again. Ledger
// credit itself stays an explicit admin action (POST /admin/balances/
// reconcile writes the signed adjustment), matching how all other
// out-of-band funds are handled.
export async function rescanRetiredAddresses(
  deps: AppDeps,
  opts: { force?: boolean } = {}
): Promise<RescanRetiredAddressesResult> {
  const skipped: RescanRetiredAddressesResult = { ran: false, scanned: 0, straysFound: 0, errors: 0 };
  const rescanHours = deps.poolRetiredRescanHours ?? DEFAULT_POOL_RETIRED_RESCAN_HOURS;
  if (rescanHours <= 0) return skipped;
  if (!opts.force) {
    const acquired = await deps.cache.putIfAbsent("pool:retired-rescan-throttle", "1", {
      ttlSeconds: rescanHours * 60 * 60
    });
    if (!acquired) return skipped;
  }

  // Resume after the last fully-processed row from the previous run; wrap to
  // the start when the end of the set is reached. Without this, a retired
  // population above one run's budget would starve the tail forever — the
  // exact silent blind spot this sweep exists to prevent.
  const cursor = await deps.cache.getJSON<RescanCursor>(RESCAN_CURSOR_CACHE_KEY);
  const conds = [isNotNull(addressPool.retiredAt)];
  if (cursor !== null) {
    conds.push(
      sql`(${addressPool.retiredAt} > ${cursor.retiredAt} OR (${addressPool.retiredAt} = ${cursor.retiredAt} AND ${addressPool.id} > ${cursor.id}))`
    );
  }
  const rows = await deps.db
    .select({
      id: addressPool.id,
      family: addressPool.family,
      address: addressPool.address,
      addressIndex: addressPool.addressIndex,
      retiredAt: addressPool.retiredAt
    })
    .from(addressPool)
    .where(and(...conds))
    .orderBy(asc(addressPool.retiredAt), asc(addressPool.id))
    .limit(RESCAN_MAX_ADDRESSES_PER_RUN);
  if (rows.length === 0) {
    // End of set (or empty set): clear the cursor so the next run starts over.
    if (cursor !== null) await deps.cache.delete(RESCAN_CURSOR_CACHE_KEY);
    return { ran: true, scanned: 0, straysFound: 0, errors: 0 };
  }

  const adaptersByFamily = accountModelAdaptersByFamily(deps);
  const result: RescanRetiredAddressesResult = { ran: true, scanned: 0, straysFound: 0, errors: 0 };
  let probesLeft = RESCAN_MAX_RPC_PROBES_PER_RUN;
  let lastProcessed: RescanCursor | null = null;
  let exhaustedBudget = false;

  for (const row of rows) {
    const adapters = adaptersByFamily.get(row.family as ChainFamily) ?? [];
    if (adapters.length === 0) {
      // No wired adapter (family removed from config) — skip but advance the
      // cursor so these rows don't permanently occupy the page.
      lastProcessed = { retiredAt: row.retiredAt ?? 0, id: row.id };
      continue;
    }
    const probesNeeded = adapters.reduce((n, a) => n + a.supportedChainIds.length, 0);
    if (probesNeeded > probesLeft) {
      exhaustedBudget = true;
      break; // never half-scan an address — resume it next run
    }
    result.scanned += 1;
    let stray = false;
    for (const adapter of adapters) {
      for (const chainId of adapter.supportedChainIds) {
        probesLeft -= 1;
        let balances;
        try {
          balances = await adapter.getAccountBalances({
            chainId: chainId as ChainId,
            address: row.address as Address
          });
        } catch (err) {
          result.errors += 1;
          deps.logger.warn("pool.retired_rescan.balance_failed", {
            chainId,
            address: row.address,
            error: err instanceof Error ? err.message : String(err)
          });
          continue;
        }
        for (const b of balances) {
          const onChain = BigInt(b.amountRaw);
          if (onChain <= 0n) continue;
          // Nonzero on-chain — compare against what the ledger already knows
          // (a retired row normally reads 0 everywhere; an adjustment written
          // after retirement is the accounted-for exception).
          const ledger = await computeSpendable(deps, {
            chainId,
            address: row.address,
            token: b.token as string
          });
          if (onChain <= ledger) continue;
          // Transient surpluses the system already tracks are NOT strays:
          // an unreleased reservation (in-flight consolidation sweep from
          // this parked row) or a detected-awaiting-confirm credit both
          // resolve via their own sweeps — alerting would page the on-call
          // for funds that are fully accounted for.
          const [activeReservation] = await deps.db
            .select({ id: payoutReservations.id })
            .from(payoutReservations)
            .where(
              and(
                isNull(payoutReservations.releasedAt),
                eq(payoutReservations.address, row.address)
              )
            )
            .limit(1);
          if (activeReservation !== undefined) continue;
          const [pendingCredit] = await deps.db
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                sql`${transactions.status} = 'detected'`,
                eq(transactions.chainId, chainId),
                eq(transactions.toAddress, row.address)
              )
            )
            .limit(1);
          if (pendingCredit !== undefined) continue;
          stray = true;
          deps.logger.error("pool.retired_address_stray_funds", {
            chainId,
            family: row.family,
            address: row.address,
            token: b.token,
            onChainRaw: onChain.toString(),
            ledgerRaw: ledger.toString(),
            action:
              "address re-watched; run POST /admin/balances/reconcile to credit the ledger"
          });
        }
        if (stray) break;
      }
      if (stray) break;
    }
    lastProcessed = { retiredAt: row.retiredAt ?? 0, id: row.id };
    if (stray) {
      result.straysFound += 1;
      // Un-retire: back to 'available' unless the operator parked it (then it
      // stays 'quarantined' but gets re-watched), or it was borrowed while we
      // scanned (then it's already 'allocated' and watched — publish is a
      // harmless duplicate). lastReleasedAt is stamped so the next hourly
      // shrink's idle gate doesn't immediately re-retire an address KNOWN to
      // receive out-of-band funds (the ledger still reads zero until the
      // admin reconciles — without the stamp this would flap daily and sit
      // unwatched ~23h/day).
      await deps.db
        .update(addressPool)
        .set({
          retiredAt: null,
          lastReleasedAt: deps.clock.now().getTime(),
          status: sql`CASE WHEN ${addressPool.disabledAt} IS NULL AND ${addressPool.status} = 'quarantined' THEN 'available' ELSE ${addressPool.status} END`
        })
        .where(eq(addressPool.id, row.id));
      await publishPoolAddressCreated(deps, {
        poolAddressId: row.id,
        family: row.family as ChainFamily,
        address: row.address,
        addressIndex: row.addressIndex,
        atMs: deps.clock.now().getTime()
      });
    }
  }

  // Persist the rotation point: resume mid-set when the budget stopped us,
  // clear when a full page was processed AND the page wasn't full (end of
  // set). A full page with budget to spare resumes from its last row.
  const reachedEnd = !exhaustedBudget && rows.length < RESCAN_MAX_ADDRESSES_PER_RUN;
  if (reachedEnd) {
    if (cursor !== null) await deps.cache.delete(RESCAN_CURSOR_CACHE_KEY);
  } else if (lastProcessed !== null) {
    await deps.cache.putJSON(RESCAN_CURSOR_CACHE_KEY, lastProcessed, {
      ttlSeconds: RESCAN_CURSOR_TTL_SECONDS
    });
  }

  if (result.straysFound > 0) kickAlchemySync(deps);
  deps.logger.info("pool.retired_rescan", { ...result });
  return result;
}

// Ledger-side zero-balance proof for retire candidates. Returns the subset of
// `addresses` that (a) hold no active payout reservation and (b) compute to
// zero spendable for every registered token + native on every chain of the
// family. Uses the same computeSpendableBatch arithmetic as the payout
// planner, so "zero" here means exactly what "unfundable" means there.
async function filterZeroLedgerBalance(
  deps: AppDeps,
  adapters: readonly ChainAdapter[],
  addresses: readonly string[]
): Promise<Set<string>> {
  const zero = new Set(addresses);
  if (zero.size === 0) return zero;

  // Any active (unreleased) reservation — even one that nets spendable to
  // zero — means an in-flight payout touches this address. Leave it alone.
  const resRows = await deps.db
    .select({ address: payoutReservations.address })
    .from(payoutReservations)
    .where(
      and(
        isNull(payoutReservations.releasedAt),
        inArray(payoutReservations.address, [...zero])
      )
    );
  for (const r of resRows) zero.delete(r.address);

  // Spendable counts only CONFIRMED credits — but a 'detected' credit is
  // funds mid-confirmation and an 'orphaned' one is funds the DB KNOWS
  // landed here (a payer re-using an old invoice URI — the strongest signal
  // this address will see MORE deposits). Retiring either would deregister
  // an address holding recorded value and set up a daily rescan-alert flap.
  // Both populations are small (detected drains within confirmations;
  // orphans sit in the admin queue), so the status-led seek stays cheap.
  const pendingRows = await deps.db
    .selectDistinct({ address: transactions.toAddress })
    .from(transactions)
    .where(
      and(
        sql`${transactions.status} IN ('detected','orphaned')`,
        inArray(transactions.toAddress, [...zero])
      )
    );
  for (const r of pendingRows) {
    if (r.address !== null) zero.delete(r.address);
  }

  for (const adapter of adapters) {
    for (const chainId of adapter.supportedChainIds) {
      if (zero.size === 0) return zero;
      const tokens = [
        adapter.nativeSymbol(chainId as ChainId) as string,
        ...TOKEN_REGISTRY.filter((t) => t.chainId === chainId).map((t) => t.symbol as string)
      ];
      const balances = await computeSpendableBatch(deps, {
        chainId,
        addresses: [...zero],
        tokens: [...new Set(tokens)]
      });
      for (const [address, byToken] of balances) {
        for (const value of byToken.values()) {
          if (value > 0n) {
            zero.delete(address);
            break;
          }
        }
      }
    }
  }
  return zero;
}

// Account-model families (the pooled ones) with their wired adapters. UTXO
// allocates fresh-per-invoice and Monero has its own subaddress pool — both
// outside address_pool lifecycle management.
function accountModelAdaptersByFamily(deps: AppDeps): Map<ChainFamily, ChainAdapter[]> {
  const byFamily = new Map<ChainFamily, ChainAdapter[]>();
  for (const adapter of deps.chains) {
    if (adapter.family === "utxo" || adapter.family === "monero") continue;
    const list = byFamily.get(adapter.family) ?? [];
    list.push(adapter);
    byFamily.set(adapter.family, list);
  }
  return byFamily;
}

// ---- Internals ----

// Watcher (re-)registration publish. The in-memory bus awaits subscribers, so
// when this resolves the Alchemy tracker's per-chain `add` rows are enqueued.
async function publishPoolAddressCreated(
  deps: AppDeps,
  args: { poolAddressId: string; family: ChainFamily; address: string; addressIndex: number; atMs: number }
): Promise<void> {
  await deps.events.publish({
    type: "pool.address.created",
    poolAddressId: args.poolAddressId,
    family: args.family,
    address: args.address,
    addressIndex: args.addressIndex,
    at: new Date(args.atMs)
  });
}

// Watcher deregistration publish (tracker enqueues per-chain `remove` rows).
async function publishPoolAddressQuarantined(
  deps: AppDeps,
  args: { poolAddressId: string; family: ChainFamily; address: string; atMs: number }
): Promise<void> {
  await deps.events.publish({
    type: "pool.address.quarantined",
    poolAddressId: args.poolAddressId,
    family: args.family,
    address: args.address,
    at: new Date(args.atMs)
  });
}

// Nudge the Alchemy sync sweep to flush freshly-enqueued add/remove rows now
// instead of on the next cron tick — shrinks the detection gap after a
// reactivation to seconds. Best-effort: a lost kick is healed by the
// per-minute scheduled sweep.
function kickAlchemySync(deps: AppDeps): void {
  const alchemy = deps.alchemy;
  if (alchemy === undefined) return;
  deps.jobs.defer(
    async () => {
      try {
        await alchemy.syncAddresses();
      } catch (err) {
        deps.logger.warn("pool.alchemy_sync_kick.failed", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    },
    { name: "alchemy-sync-kick" }
  );
}

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

// Rows currently in service (not watcher-deregistered). Used by initialize's
// idempotent top-up so retired rows don't masquerade as capacity.
async function countActivePool(deps: AppDeps, family: ChainFamily): Promise<number> {
  const [row] = await deps.db
    .select({ cnt: count() })
    .from(addressPool)
    .where(and(eq(addressPool.family, family), isNull(addressPool.retiredAt)));
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
