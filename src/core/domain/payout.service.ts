import { z } from "zod";
import type { AppDeps } from "../app-deps.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import { ChainIdSchema } from "../types/chain.js";
import { MerchantIdSchema } from "../types/merchant.js";
import { AmountRawSchema } from "../types/money.js";
import type { Payout, PayoutId } from "../types/payout.js";
import { TokenSymbolSchema } from "../types/token.js";
import { findToken } from "../types/token-registry.js";
import type { SignerScope } from "../types/signer.js";
import { findChainAdapter } from "./chain-lookup.js";
import { rowToPayout, type PayoutRow } from "./mappers.js";
import { confirmationThreshold } from "./payment-config.js";
import { DomainError } from "../errors.js";

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

export const PlanPayoutInputSchema = z.object({
  merchantId: MerchantIdSchema,
  chainId: ChainIdSchema,
  token: TokenSymbolSchema,
  amountRaw: AmountRawSchema,
  destinationAddress: z.string().min(1).max(128)
});
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

  const merchant = await deps.db
    .prepare("SELECT id, active FROM merchants WHERE id = ?")
    .bind(parsed.merchantId)
    .first<{ id: string; active: number }>();
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

  const now = deps.clock.now().getTime();
  const payoutId = globalThis.crypto.randomUUID();
  await deps.db
    .prepare(
      `INSERT INTO payouts
         (id, merchant_id, status, chain_id, token, amount_raw, destination_address,
          source_address, tx_hash, fee_estimate_native, last_error,
          created_at, submitted_at, confirmed_at, updated_at)
       VALUES (?, ?, 'planned', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)`
    )
    .bind(payoutId, parsed.merchantId, parsed.chainId, parsed.token, parsed.amountRaw, destination, now, now)
    .run();

  const row = await fetchPayout(deps, payoutId);
  if (!row) throw new Error(`planPayout: inserted row ${payoutId} disappeared`);

  await deps.events.publish({ type: "payout.planned", payoutId: row.id, payout: row, at: new Date(now) });
  return row;
}

// Register a fee wallet for a chain. Payouts on `chainId` will CAS-reserve from
// this pool. The matching private key must be put into the SignerStore before
// executions run (the adapter pulls it on demand at signing time).
export async function registerFeeWallet(
  deps: AppDeps,
  args: { chainId: number; address: string; label: string }
): Promise<void> {
  const now = deps.clock.now().getTime();
  const chainAdapter = findChainAdapter(deps, args.chainId);
  const canonical = chainAdapter.canonicalizeAddress(args.address);
  await deps.db
    .prepare(
      `INSERT INTO fee_wallets (id, chain_id, address, label, active, reserved_by_payout_id, reserved_at, created_at)
       VALUES (?, ?, ?, ?, 1, NULL, NULL, ?)
       ON CONFLICT(chain_id, address) DO UPDATE
         SET label = excluded.label, active = 1`
    )
    .bind(globalThis.crypto.randomUUID(), args.chainId, canonical, args.label, now)
    .run();
}

export interface ExecuteSweepResult {
  attempted: number;
  submitted: number;
  failed: number;
  deferred: number; // no available fee wallet; left in 'planned'
}

// Cron-triggered: promote planned payouts to submitted by CAS-reserving a fee
// wallet, building + signing + broadcasting the transfer.
export async function executeReservedPayouts(deps: AppDeps): Promise<ExecuteSweepResult> {
  const planned = await deps.db
    .prepare("SELECT * FROM payouts WHERE status = 'planned' ORDER BY created_at ASC")
    .all<PayoutRow>();

  let submitted = 0;
  let failed = 0;
  let deferred = 0;
  for (const row of planned.results) {
    const chainAdapter = findChainAdapter(deps, row.chain_id);

    // 1. CAS-reserve a free fee wallet for this chain.
    const wallet = await tryReserveFeeWallet(deps, row.chain_id, row.id);
    if (!wallet) {
      deferred += 1;
      continue;
    }

    // 2. Move the payout to 'reserved' and record the source address.
    const now1 = deps.clock.now().getTime();
    await deps.db
      .prepare("UPDATE payouts SET status = 'reserved', source_address = ?, updated_at = ? WHERE id = ?")
      .bind(wallet.address, now1, row.id)
      .run();

    // 3. Build -> sign -> broadcast. Any throw here moves us to 'failed' and
    //    releases the wallet so a retry (with a different or the same wallet)
    //    can proceed.
    //
    // DEFERRED (Stage B.2, double-spend hardening): we do NOT persist the
    // unsigned tx + nonce before broadcast. If the process crashes AFTER
    // broadcast but BEFORE the status='submitted' write below, a retry will
    // call buildTransfer again with a fresh nonce and broadcast a second tx.
    // Fix requires a `broadcast_intent` row written in the same batch as the
    // 'reserved' transition, then idempotent re-broadcast on retry. Tracked
    // as Stage B.2 — NOT safe to enable real-money payouts until resolved.
    try {
      const unsigned = await chainAdapter.buildTransfer({
        chainId: row.chain_id,
        fromAddress: wallet.address,
        toAddress: row.destination_address,
        token: row.token,
        amountRaw: row.amount_raw
      });

      const signerScope: SignerScope = feeWalletScope(chainAdapter, wallet.label);
      const privateKey = await deps.signerStore.get(signerScope);
      const txHash = await chainAdapter.signAndBroadcast(unsigned, privateKey);

      const now2 = deps.clock.now().getTime();
      await deps.db
        .prepare(
          "UPDATE payouts SET status = 'submitted', tx_hash = ?, submitted_at = ?, updated_at = ? WHERE id = ?"
        )
        .bind(txHash, now2, now2, row.id)
        .run();

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
      await deps.db.batch([
        deps.db
          .prepare("UPDATE payouts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
          .bind(message.slice(0, 2048), now2, row.id),
        releaseFeeWalletStmt(deps, row.id)
      ]);

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

  return { attempted: planned.results.length, submitted, failed, deferred };
}

export interface ConfirmPayoutsResult {
  checked: number;
  confirmed: number;
  failed: number;
}

// Cron-triggered: move submitted payouts to confirmed or failed based on the
// chain's current view of their tx hash. Releases the fee wallet on terminal states.
export async function confirmPayouts(deps: AppDeps): Promise<ConfirmPayoutsResult> {
  const submitted = await deps.db
    .prepare("SELECT * FROM payouts WHERE status = 'submitted'")
    .all<PayoutRow>();

  let confirmed = 0;
  let failed = 0;
  for (const row of submitted.results) {
    if (!row.tx_hash) continue;
    const chainAdapter = findChainAdapter(deps, row.chain_id);
    const status = await chainAdapter.getConfirmationStatus(row.chain_id, row.tx_hash);
    const now = deps.clock.now().getTime();
    const threshold = confirmationThreshold(row.chain_id);

    if (status.reverted) {
      // Batched with releaseFeeWallet so the two writes commit together.
      await deps.db.batch([
        deps.db
          .prepare("UPDATE payouts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
          .bind("Transaction reverted on-chain", now, row.id),
        releaseFeeWalletStmt(deps, row.id)
      ]);
      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({ type: "payout.failed", payoutId: updated.id, payout: updated, at: new Date(now) });
      }
      failed += 1;
      continue;
    }

    if (status.confirmations >= threshold) {
      // Batched with releaseFeeWallet so the two writes commit together.
      await deps.db.batch([
        deps.db
          .prepare("UPDATE payouts SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?")
          .bind(now, now, row.id),
        releaseFeeWalletStmt(deps, row.id)
      ]);
      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({ type: "payout.confirmed", payoutId: updated.id, payout: updated, at: new Date(now) });
      }
      confirmed += 1;
    }
  }

  return { checked: submitted.results.length, confirmed, failed };
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
//    under a D1/libSQL failure.
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
    .prepare(
      `UPDATE fee_wallets
          SET reserved_by_payout_id = NULL, reserved_at = NULL
        WHERE reserved_by_payout_id IS NOT NULL
          AND reserved_by_payout_id IN (
            SELECT id FROM payouts WHERE status IN ('confirmed', 'failed', 'canceled')
          )`
    )
    .run();

  const stuck = await deps.db
    .prepare(
      `SELECT fw.id AS wallet_id, fw.address, fw.reserved_by_payout_id AS payout_id,
              fw.reserved_at, p.status AS payout_status
         FROM fee_wallets fw
         JOIN payouts p ON p.id = fw.reserved_by_payout_id
        WHERE fw.reserved_at IS NOT NULL
          AND fw.reserved_at < ?
          AND p.status = 'reserved'`
    )
    .bind(now - stuckThresholdMs)
    .all<{
      wallet_id: string;
      address: string;
      payout_id: string;
      reserved_at: number;
      payout_status: string;
    }>();

  for (const row of stuck.results) {
    deps.logger.warn("fee wallet reservation stuck mid-broadcast; operator review required", {
      walletId: row.wallet_id,
      address: row.address,
      payoutId: row.payout_id,
      payoutStatus: row.payout_status,
      reservedAt: new Date(row.reserved_at).toISOString(),
      heldMinutes: Math.round((now - row.reserved_at) / 60_000)
    });
  }

  return {
    releasedTerminal: terminalRelease.meta.changes ?? 0,
    stuckPending: stuck.results.length
  };
}

// ---- Internals ----

async function fetchPayout(deps: AppDeps, id: string): Promise<Payout | null> {
  const row = await deps.db.prepare("SELECT * FROM payouts WHERE id = ?").bind(id).first<PayoutRow>();
  return row ? rowToPayout(row) : null;
}

// Atomic fee-wallet selection: pick any active, unreserved wallet on this
// chain, mark it reserved-by-this-payout. Returns null if none are free.
async function tryReserveFeeWallet(
  deps: AppDeps,
  chainId: number,
  payoutId: string
): Promise<{ id: string; address: string; label: string } | null> {
  const now = deps.clock.now().getTime();
  // Two-step: pick a candidate, then CAS. Doing it in one UPDATE with a
  // subselect would be cleaner, but libSQL's UPDATE-with-subquery edge cases
  // are historically flaky compared to D1. This is portable.
  const candidate = await deps.db
    .prepare(
      "SELECT id, address, label FROM fee_wallets WHERE chain_id = ? AND active = 1 AND reserved_by_payout_id IS NULL LIMIT 1"
    )
    .bind(chainId)
    .first<{ id: string; address: string; label: string }>();
  if (!candidate) return null;

  const claim = await deps.db
    .prepare(
      `UPDATE fee_wallets
          SET reserved_by_payout_id = ?, reserved_at = ?
        WHERE id = ? AND reserved_by_payout_id IS NULL
        RETURNING id, address, label`
    )
    .bind(payoutId, now, candidate.id)
    .first<{ id: string; address: string; label: string }>();
  return claim ?? null;
}

// Returns the prepared statement without executing it, so callers can include
// it in a `db.batch([...])` alongside the terminal status update. The two
// writes must commit atomically — a crash between them strands the wallet.
function releaseFeeWalletStmt(deps: AppDeps, payoutId: string) {
  return deps.db
    .prepare(
      "UPDATE fee_wallets SET reserved_by_payout_id = NULL, reserved_at = NULL WHERE reserved_by_payout_id = ?"
    )
    .bind(payoutId);
}

function feeWalletScope(chainAdapter: ChainAdapter, label: string): SignerScope {
  return { kind: "fee-wallet", family: chainAdapter.family, label };
}
