import { z } from "zod";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import { ChainIdSchema, type Address, type ChainId } from "../types/chain.js";
import { MerchantIdSchema } from "../types/merchant.js";
import { AmountRawSchema } from "../types/money.js";
import type { Payout, PayoutId } from "../types/payout.js";
import { TokenSymbolSchema, type TokenSymbol } from "../types/token.js";
import { findToken } from "../types/token-registry.js";
import type { SignerScope } from "../types/signer.js";
import { findChainAdapter } from "./chain-lookup.js";
import { drizzleRowToPayout } from "./mappers.js";
import { confirmationThreshold } from "./payment-config.js";
import { DomainError } from "../errors.js";
import { feeWallets, merchants, payouts } from "../../db/schema.js";

// PayoutService lifecycle:
//
//   planned    -> row inserted; no fee wallet committed yet
//   reserved   -> CAS-claimed a fee wallet (one in-flight payout per wallet)
//   submitted  -> broadcast OK; have txHash; awaiting confirmations
//   confirmed  -> N confirmations reached; fee wallet released
//   failed     -> broadcast error or on-chain revert; fee wallet released
//   canceled   -> admin canceled before broadcast; fee wallet released if held
//
// The service is cron-driven: `executeReservedPayouts` pushes planned rows
// forward to submitted; `confirmPayouts` pushes submitted rows forward to
// confirmed/failed. Neither blocks on the chain — each tick processes whatever
// is ready and returns, so a slow RPC can't stall the scheduler.

// ---- Input validation ----

export const PlanPayoutInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    chainId: ChainIdSchema,
    token: TokenSymbolSchema,
    amountRaw: AmountRawSchema,
    destinationAddress: z.string().min(1).max(128),

    // Per-payout webhook override. Both URL and secret must be provided
    // together — sending only one would dispatch events HMAC-signed with the
    // wrong key (or to the wrong URL with the merchant's key) and silently
    // break verification on the merchant's side. The secret is encrypted at
    // rest and never echoed in any API response.
    webhookUrl: z.string().url().optional(),
    webhookSecret: z.string().min(16).max(512).optional()
  })
  .refine(
    (v) => (v.webhookUrl === undefined) === (v.webhookSecret === undefined),
    {
      message:
        "`webhookUrl` and `webhookSecret` must be provided together — one without the other would sign events with a mismatched key"
    }
  );
export type PlanPayoutInput = z.infer<typeof PlanPayoutInputSchema>;

// ---- Errors ----

export type PayoutErrorCode =
  | "MERCHANT_NOT_FOUND"
  | "MERCHANT_INACTIVE"
  | "TOKEN_NOT_SUPPORTED"
  | "INVALID_DESTINATION"
  | "NO_FEE_WALLET_AVAILABLE";

const PAYOUT_ERROR_HTTP_STATUS: Readonly<Record<PayoutErrorCode, number>> = {
  MERCHANT_NOT_FOUND: 404,
  MERCHANT_INACTIVE: 403,
  TOKEN_NOT_SUPPORTED: 400,
  INVALID_DESTINATION: 400,
  NO_FEE_WALLET_AVAILABLE: 503
};

export class PayoutError extends DomainError {
  declare readonly code: PayoutErrorCode;
  constructor(code: PayoutErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, PAYOUT_ERROR_HTTP_STATUS[code], details);
    this.name = "PayoutError";
  }
}

// ---- Operations ----

export async function planPayout(deps: AppDeps, input: unknown): Promise<Payout> {
  const parsed = PlanPayoutInputSchema.parse(input);

  const [merchant] = await deps.db
    .select({ id: merchants.id, active: merchants.active })
    .from(merchants)
    .where(eq(merchants.id, parsed.merchantId))
    .limit(1);
  if (!merchant) throw new PayoutError("MERCHANT_NOT_FOUND", `Merchant not found: ${parsed.merchantId}`);
  if (merchant.active !== 1) throw new PayoutError("MERCHANT_INACTIVE", `Merchant is inactive: ${parsed.merchantId}`);

  const token = findToken(parsed.chainId, parsed.token);
  if (!token) {
    throw new PayoutError(
      "TOKEN_NOT_SUPPORTED",
      `Token ${parsed.token} not supported on chain ${parsed.chainId}`
    );
  }

  const chainAdapter = findChainAdapter(deps, parsed.chainId);
  if (!chainAdapter.validateAddress(parsed.destinationAddress)) {
    throw new PayoutError("INVALID_DESTINATION", `Invalid ${chainAdapter.family} address: ${parsed.destinationAddress}`);
  }
  const destination = chainAdapter.canonicalizeAddress(parsed.destinationAddress);

  // Encrypt the per-payout webhook secret if one was provided. Stored
  // ciphertext only; plaintext lives only in the request body and the
  // decrypt-then-HMAC stack frame at dispatch time. URL+secret pairing is
  // enforced by the input schema's refine — both NULL means fall back to the
  // merchant default.
  const webhookSecretCiphertext =
    parsed.webhookSecret !== undefined
      ? await deps.secretsCipher.encrypt(parsed.webhookSecret)
      : null;

  const now = deps.clock.now().getTime();
  const payoutId = globalThis.crypto.randomUUID();
  await deps.db.insert(payouts).values({
    id: payoutId,
    merchantId: parsed.merchantId,
    status: "planned",
    chainId: parsed.chainId,
    token: parsed.token,
    amountRaw: parsed.amountRaw,
    destinationAddress: destination,
    sourceAddress: null,
    txHash: null,
    feeEstimateNative: null,
    lastError: null,
    createdAt: now,
    submittedAt: null,
    confirmedAt: null,
    updatedAt: now,
    webhookUrl: parsed.webhookUrl ?? null,
    webhookSecretCiphertext: webhookSecretCiphertext
  });

  const row = await fetchPayout(deps, payoutId);
  if (!row) throw new Error(`planPayout: inserted row ${payoutId} disappeared`);

  await deps.events.publish({ type: "payout.planned", payoutId: row.id, payout: row, at: new Date(now) });
  return row;
}

// Register a fee wallet for a chain. Payouts on `chainId` will CAS-reserve from
// this pool. The matching private key is HD-derived on demand from MASTER_SEED
// at execution time — nothing is stored at rest.
export async function registerFeeWallet(
  deps: AppDeps,
  args: { chainId: number; address: string; label: string }
): Promise<void> {
  const now = deps.clock.now().getTime();
  const chainAdapter = findChainAdapter(deps, args.chainId);
  const canonical = chainAdapter.canonicalizeAddress(args.address);
  await deps.db
    .insert(feeWallets)
    .values({
      id: globalThis.crypto.randomUUID(),
      chainId: args.chainId,
      address: canonical,
      label: args.label,
      active: 1,
      reservedByPayoutId: null,
      reservedAt: null,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: [feeWallets.chainId, feeWallets.address],
      set: { label: args.label, active: 1 }
    });
}

export interface ExecuteSweepResult {
  attempted: number;
  submitted: number;
  failed: number;
  deferred: number; // no available fee wallet; left in 'planned'
}

export interface ExecuteReservedPayoutsOptions {
  // Caps the rows fetched per tick. Bounding the batch keeps a long queue
  // from pushing runScheduledJobs past Workers' 30s CPU limit — partial
  // progress is safe because the cron re-runs frequently.
  maxBatch?: number;
}

// Cron-triggered: promote planned payouts to submitted by CAS-reserving a fee
// wallet, building + signing + broadcasting the transfer.
export async function executeReservedPayouts(
  deps: AppDeps,
  opts: ExecuteReservedPayoutsOptions = {}
): Promise<ExecuteSweepResult> {
  const limit = opts.maxBatch ?? 200;
  const planned = await deps.db
    .select()
    .from(payouts)
    .where(eq(payouts.status, "planned"))
    .orderBy(asc(payouts.createdAt))
    .limit(limit);

  let submitted = 0;
  let failed = 0;
  let deferred = 0;
  for (const row of planned) {
    const chainAdapter = findChainAdapter(deps, row.chainId);

    // 1. CAS-reserve a free fee wallet for this chain.
    const wallet = await tryReserveFeeWallet(deps, row.chainId, row.id);
    if (!wallet) {
      deferred += 1;
      continue;
    }

    // 2. Move the payout to 'reserved' and record the source address.
    const now1 = deps.clock.now().getTime();
    await deps.db
      .update(payouts)
      .set({ status: "reserved", sourceAddress: wallet.address, updatedAt: now1 })
      .where(eq(payouts.id, row.id));

    // 3. Claim the broadcast slot (CAS on broadcast_attempted_at) BEFORE calling
    //    the chain adapter. If the CAS loses (returns null) either another
    //    worker already broadcast this payout, or a previous attempt crashed
    //    after broadcast but before we could record success. Either way, we
    //    MUST NOT broadcast again — doing so would double-spend the fee wallet.
    //    Fail-shut: flip to 'failed' and release the wallet so an operator can
    //    manually reconcile with on-chain state before retrying.
    const [broadcastClaim] = await deps.db
      .update(payouts)
      .set({ broadcastAttemptedAt: deps.clock.now().getTime() })
      .where(
        and(
          eq(payouts.id, row.id),
          isNull(payouts.broadcastAttemptedAt),
          eq(payouts.status, "reserved")
        )
      )
      .returning({ id: payouts.id });
    if (!broadcastClaim) {
      // Someone else is broadcasting this row (or already did). Don't touch it.
      deferred += 1;
      continue;
    }

    // 4. Balance pre-flight. Before we burn energy/gas on a tx that will
    //    revert on-chain, ask the adapter what the fee wallet actually holds
    //    and bail early if it's short. Adapters that haven't implemented
    //    getBalance (Tron, Solana) throw — we catch and continue under the
    //    "broadcast and let the chain decide" fallback so we don't break
    //    existing flows while the coverage gap is closed iteratively.
    try {
      const walletBalance = await chainAdapter.getBalance({
        chainId: row.chainId as ChainId,
        address: wallet.address as Address,
        token: row.token as TokenSymbol
      });
      if (BigInt(walletBalance) < BigInt(row.amountRaw)) {
        throw new Error(
          `Insufficient ${row.token} balance on fee wallet ${wallet.address}: ` +
            `have ${walletBalance}, need ${row.amountRaw}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish "adapter can't check" (benign) from "adapter says no"
      // (hard fail). The "not implemented" path logs once and proceeds.
      if (message.includes("not implemented")) {
        deps.logger.debug("balance pre-check skipped (adapter not implemented)", {
          payoutId: row.id,
          chainId: row.chainId
        });
      } else if (message.startsWith("Insufficient ")) {
        // Hard fail — fee wallet short. Mark failed + release the wallet so
        // the operator can top it up and the payout gets re-planned manually
        // (we don't auto-retry a known-bad wallet).
        const now2 = deps.clock.now().getTime();
        const failStmt = deps.db
          .update(payouts)
          .set({ status: "failed", lastError: message.slice(0, 2048), updatedAt: now2 })
          .where(eq(payouts.id, row.id));
        const releaseStmt = releaseFeeWalletStmt(deps, row.id);
        await deps.db.batch([failStmt, releaseStmt] as [typeof failStmt, typeof releaseStmt]);
        const updated = await fetchPayout(deps, row.id);
        if (updated) {
          await deps.events.publish({
            type: "payout.failed",
            payoutId: updated.id,
            payout: updated,
            at: new Date(now2)
          });
        }
        failed += 1;
        continue;
      } else {
        // Transient RPC error reading balance. Log, proceed to broadcast —
        // the chain's own simulation/preflight is our backstop.
        deps.logger.warn("balance pre-check failed; proceeding to broadcast", {
          payoutId: row.id,
          chainId: row.chainId,
          error: message
        });
      }
    }

    // 5. Build -> sign -> broadcast. Any throw here moves us to 'failed' and
    //    releases the wallet so a retry (with a different or the same wallet)
    //    can proceed. Because the broadcast slot is already claimed above, a
    //    retry after this point will not re-enter this block for this row.
    try {
      const unsigned = await chainAdapter.buildTransfer({
        chainId: row.chainId,
        fromAddress: wallet.address,
        toAddress: row.destinationAddress,
        token: row.token,
        amountRaw: row.amountRaw
      });

      const signerScope: SignerScope = feeWalletScope(chainAdapter, wallet.label);
      const privateKey = await deps.signerStore.get(signerScope);
      const txHash = await chainAdapter.signAndBroadcast(unsigned, privateKey);

      const now2 = deps.clock.now().getTime();
      await deps.db
        .update(payouts)
        .set({ status: "submitted", txHash, submittedAt: now2, updatedAt: now2 })
        .where(eq(payouts.id, row.id));

      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({
          type: "payout.submitted",
          payoutId: updated.id,
          payout: updated,
          at: new Date(now2)
        });
      }
      submitted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now2 = deps.clock.now().getTime();
      // Terminal transition: flip payout to 'failed' AND release the fee wallet
      // in a single atomic batch. A crash between the two statements would
      // otherwise leave the wallet reserved forever.
      const failStmt = deps.db
        .update(payouts)
        .set({ status: "failed", lastError: message.slice(0, 2048), updatedAt: now2 })
        .where(eq(payouts.id, row.id));
      const releaseStmt = releaseFeeWalletStmt(deps, row.id);
      await deps.db.batch([failStmt, releaseStmt] as [typeof failStmt, typeof releaseStmt]);

      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({
          type: "payout.failed",
          payoutId: updated.id,
          payout: updated,
          at: new Date(now2)
        });
      }
      failed += 1;
    }
  }

  return { attempted: planned.length, submitted, failed, deferred };
}

export interface ConfirmPayoutsResult {
  checked: number;
  confirmed: number;
  failed: number;
}

export interface ConfirmPayoutsOptions {
  // See ExecuteReservedPayoutsOptions.maxBatch — same rationale.
  maxBatch?: number;
}

// Cron-triggered: move submitted payouts to confirmed or failed based on the
// chain's current view of their tx hash. Releases the fee wallet on terminal states.
export async function confirmPayouts(
  deps: AppDeps,
  opts: ConfirmPayoutsOptions = {}
): Promise<ConfirmPayoutsResult> {
  const limit = opts.maxBatch ?? 200;
  const submitted = await deps.db
    .select()
    .from(payouts)
    .where(eq(payouts.status, "submitted"))
    .orderBy(asc(payouts.submittedAt))
    .limit(limit);

  let confirmed = 0;
  let failed = 0;
  for (const row of submitted) {
    if (!row.txHash) continue;
    const chainAdapter = findChainAdapter(deps, row.chainId);
    const status = await chainAdapter.getConfirmationStatus(row.chainId, row.txHash);
    const now = deps.clock.now().getTime();
    const threshold = confirmationThreshold(row.chainId, deps.confirmationThresholds);

    if (status.reverted) {
      // Batched with releaseFeeWallet so the two writes commit together.
      const failStmt = deps.db
        .update(payouts)
        .set({ status: "failed", lastError: "Transaction reverted on-chain", updatedAt: now })
        .where(eq(payouts.id, row.id));
      const releaseStmt = releaseFeeWalletStmt(deps, row.id);
      await deps.db.batch([failStmt, releaseStmt] as [typeof failStmt, typeof releaseStmt]);
      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({ type: "payout.failed", payoutId: updated.id, payout: updated, at: new Date(now) });
      }
      failed += 1;
      continue;
    }

    if (status.confirmations >= threshold) {
      // Batched with releaseFeeWallet so the two writes commit together.
      const confirmStmt = deps.db
        .update(payouts)
        .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
        .where(eq(payouts.id, row.id));
      const releaseStmt = releaseFeeWalletStmt(deps, row.id);
      await deps.db.batch([confirmStmt, releaseStmt] as [typeof confirmStmt, typeof releaseStmt]);
      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({ type: "payout.confirmed", payoutId: updated.id, payout: updated, at: new Date(now) });
      }
      confirmed += 1;
    }
  }

  return { checked: submitted.length, confirmed, failed };
}

export async function getPayout(deps: AppDeps, id: PayoutId): Promise<Payout | null> {
  return fetchPayout(deps, id);
}

export interface FeeWalletSweepResult {
  // Reservations cleared because the owning payout was already in a terminal
  // state (confirmed / failed / canceled) — defense-in-depth for the atomic
  // batch fix; expected to be zero on a healthy system.
  releasedTerminal: number;
  // Reservations older than `stuckThresholdMs` whose payout is still `reserved`
  // (i.e. mid-broadcast crash). NOT auto-released — we can't tell whether the
  // broadcast landed on-chain without a tx_hash. Logged for operator review.
  stuckPending: number;
}

export interface SweepStuckFeeWalletReservationsOptions {
  // Reservations older than this in 'reserved' state are flagged as stuck.
  // Defaults to 30 minutes — well above any realistic broadcast time, below
  // any cron that a human operator would tolerate as silent.
  stuckThresholdMs?: number;
}

// Cron-triggered watchdog. Two responsibilities:
//
// 1. **Terminal-state release (defense-in-depth)** — find any fee wallet whose
//    `reserved_by_payout_id` points at a payout in a terminal state and clear
//    it. The atomic batch in confirmPayouts / executeReservedPayouts.failed
//    path makes this a no-op on new rows; it catches legacy strands and
//    covers the (rare) case where the batch itself partially committed
//    under a libSQL failure.
//
// 2. **Stuck-pending alert** — any fee wallet reserved > `stuckThresholdMs` ago
//    whose payout is still `reserved` (no tx_hash recorded) is logged at WARN.
//    We intentionally do NOT auto-release: if the broadcast did land on-chain
//    but we crashed before writing tx_hash, releasing the wallet would let a
//    second payout reuse it while the ghost tx still settles. Operator
//    intervention required.
export async function sweepStuckFeeWalletReservations(
  deps: AppDeps,
  opts: SweepStuckFeeWalletReservationsOptions = {}
): Promise<FeeWalletSweepResult> {
  const stuckThresholdMs = opts.stuckThresholdMs ?? 30 * 60 * 1000;
  const now = deps.clock.now().getTime();

  const terminalRelease = await deps.db
    .update(feeWallets)
    .set({ reservedByPayoutId: null, reservedAt: null })
    .where(
      and(
        isNotNull(feeWallets.reservedByPayoutId),
        inArray(
          feeWallets.reservedByPayoutId,
          deps.db
            .select({ id: payouts.id })
            .from(payouts)
            .where(inArray(payouts.status, ["confirmed", "failed", "canceled"]))
        )
      )
    )
    .returning({ id: feeWallets.id });

  const stuck = await deps.db
    .select({
      walletId: feeWallets.id,
      address: feeWallets.address,
      payoutId: feeWallets.reservedByPayoutId,
      reservedAt: feeWallets.reservedAt,
      payoutStatus: payouts.status
    })
    .from(feeWallets)
    .innerJoin(payouts, eq(payouts.id, feeWallets.reservedByPayoutId))
    .where(
      and(
        isNotNull(feeWallets.reservedAt),
        lt(feeWallets.reservedAt, now - stuckThresholdMs),
        eq(payouts.status, "reserved")
      )
    );

  for (const row of stuck) {
    deps.logger.warn("fee wallet reservation stuck mid-broadcast; operator review required", {
      walletId: row.walletId,
      address: row.address,
      payoutId: row.payoutId,
      payoutStatus: row.payoutStatus,
      reservedAt: row.reservedAt === null ? null : new Date(row.reservedAt).toISOString(),
      heldMinutes: row.reservedAt === null ? null : Math.round((now - row.reservedAt) / 60_000)
    });
  }

  return {
    releasedTerminal: terminalRelease.length,
    stuckPending: stuck.length
  };
}

// ---- Internals ----

async function fetchPayout(deps: AppDeps, id: string): Promise<Payout | null> {
  const [row] = await deps.db.select().from(payouts).where(eq(payouts.id, id)).limit(1);
  return row ? drizzleRowToPayout(row) : null;
}

// Atomic fee-wallet selection: pick any active, unreserved wallet on this
// chain, mark it reserved-by-this-payout. Returns null if none are free.
//
// Two-step pattern (SELECT candidate, then CAS UPDATE): doing it as a single
// UPDATE with a subselect would be one round-trip but libSQL's UPDATE-with-
// subquery edge cases have historically been flaky. Instead, we loop: if the
// CAS loses to a racing concurrent reservation of the same
// candidate, pick the next free wallet and try again. Without the retry,
// contention on a busy chain returned a spurious "NO_FEE_WALLETS" even when
// additional free wallets existed.
const FEE_WALLET_CAS_MAX_ATTEMPTS = 5;
async function tryReserveFeeWallet(
  deps: AppDeps,
  chainId: number,
  payoutId: string
): Promise<{ id: string; address: string; label: string } | null> {
  const now = deps.clock.now().getTime();
  for (let attempt = 0; attempt < FEE_WALLET_CAS_MAX_ATTEMPTS; attempt += 1) {
    const [candidate] = await deps.db
      .select({ id: feeWallets.id, address: feeWallets.address, label: feeWallets.label })
      .from(feeWallets)
      .where(
        and(
          eq(feeWallets.chainId, chainId),
          eq(feeWallets.active, 1),
          isNull(feeWallets.reservedByPayoutId)
        )
      )
      .limit(1);
    if (!candidate) return null;

    const [claim] = await deps.db
      .update(feeWallets)
      .set({ reservedByPayoutId: payoutId, reservedAt: now })
      .where(and(eq(feeWallets.id, candidate.id), isNull(feeWallets.reservedByPayoutId)))
      .returning({ id: feeWallets.id, address: feeWallets.address, label: feeWallets.label });
    if (claim) return claim;
    // CAS lost — someone else reserved this wallet between our SELECT and
    // UPDATE. Loop to pick the next free candidate.
  }
  return null;
}

// Returns a Drizzle update builder without executing it, so callers can
// include it in a `db.batch([...])` alongside the terminal status
// update. The two writes must commit atomically — a crash between them
// strands the wallet.
function releaseFeeWalletStmt(deps: AppDeps, payoutId: string) {
  return deps.db
    .update(feeWallets)
    .set({ reservedByPayoutId: null, reservedAt: null })
    .where(eq(feeWallets.reservedByPayoutId, payoutId));
}

function feeWalletScope(chainAdapter: ChainAdapter, label: string): SignerScope {
  return { kind: "fee-wallet", family: chainAdapter.family, label };
}
