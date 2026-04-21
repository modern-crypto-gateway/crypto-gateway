import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, type SQL } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import { ChainIdSchema, type Address, type ChainId } from "../types/chain.js";
import { MerchantIdSchema } from "../types/merchant.js";
import { AmountRawSchema, type AmountRaw } from "../types/money.js";
import type { Payout, PayoutId } from "../types/payout.js";
import { TokenSymbolSchema, type TokenSymbol } from "../types/token.js";
import { findToken } from "../types/token-registry.js";
import type { SignerScope } from "../types/signer.js";
import { findChainAdapter } from "./chain-lookup.js";
import { drizzleRowToPayout } from "./mappers.js";
import { confirmationThreshold } from "./payment-config.js";
import { DomainError } from "../errors.js";
import { assertWebhookUrlSafe } from "./url-safety.js";
import { addressPool, merchants, payoutReservations, payouts } from "../../db/schema.js";
import { computeSpendable } from "./balance-snapshot.service.js";

// PayoutService lifecycle:
//
//   planned    -> row inserted; source not yet picked
//   reserved   -> selectSource picked an HD source; reservation rows
//                 inserted to debit available balance
//   topping-up -> source lacked native for gas; sponsor → source top-up
//                 broadcast and waiting for confirmations
//   submitted  -> main tx broadcast; awaiting confirmations
//   confirmed  -> N confirmations reached; reservations released
//   failed     -> broadcast/top-up errored or on-chain reverted; reservations released
//   canceled   -> admin canceled before broadcast; reservations released
//
// The service is cron-driven: `executeReservedPayouts` advances planned and
// topping-up rows toward submitted; `confirmPayouts` advances submitted rows
// toward confirmed/failed.

// ---- Input validation ----

const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;

export const PlanPayoutInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    chainId: ChainIdSchema,
    token: TokenSymbolSchema,
    amountRaw: AmountRawSchema.optional(),
    amount: z.string().regex(DECIMAL_STRING, "amount must be a non-negative decimal string").optional(),
    amountUSD: z.string().regex(DECIMAL_STRING, "amountUSD must be a non-negative decimal string").optional(),
    feeTier: z.enum(["low", "medium", "high"]).optional(),
    batchId: z.string().min(1).max(64).optional(),
    destinationAddress: z.string().min(1).max(128),
    webhookUrl: z.string().url().optional(),
    webhookSecret: z.string().min(16).max(512).optional()
  })
  .strict()
  .refine(
    (v) => (v.webhookUrl === undefined) === (v.webhookSecret === undefined),
    {
      message:
        "`webhookUrl` and `webhookSecret` must be provided together — one without the other would sign events with a mismatched key"
    }
  )
  .refine(
    (v) =>
      Number(v.amountRaw !== undefined) +
        Number(v.amount !== undefined) +
        Number(v.amountUSD !== undefined) ===
      1,
    { message: "Provide exactly one of: amountRaw, amount, amountUSD" }
  );
export type PlanPayoutInput = z.infer<typeof PlanPayoutInputSchema>;

// ---- Errors ----

export type PayoutErrorCode =
  | "MERCHANT_NOT_FOUND"
  | "MERCHANT_INACTIVE"
  | "TOKEN_NOT_SUPPORTED"
  | "INVALID_DESTINATION"
  | "BAD_AMOUNT"
  | "ORACLE_FAILED"
  | "INVALID_FEE_TIER"
  | "FEE_ESTIMATE_FAILED"
  | "BATCH_TOO_LARGE"
  | "INSUFFICIENT_BALANCE_ANY_SOURCE"
  | "NO_GAS_SPONSOR_AVAILABLE"
  | "MAX_AMOUNT_EXCEEDS_NET_SPENDABLE"
  | "TOP_UP_BROADCAST_FAILED"
  | "TOP_UP_REVERTED"
  | "SOURCE_BROADCAST_FAILED"
  | "PAYOUT_NOT_FOUND"
  | "PAYOUT_NOT_CANCELABLE";

// Codes whose failure reason originates from the chain RPC (not internal
// gateway state). For these we PASS THROUGH the chain-reported message —
// "insufficient funds for gas * price + value", "nonce too low",
// "replacement transaction underpriced" — because these are exactly what
// the merchant/operator needs to act. A light regex scrubbed foreign
// addresses + RPC URLs before persistence; everything else flows through.
//
// Codes NOT in this set use the stable `MERCHANT_FACING_FAIL_MESSAGES`
// table — those describe internal gateway state and must not leak raw
// wrapper/plumbing messages.
const CHAIN_REPORTED_ERROR_CODES: ReadonlySet<PayoutErrorCode> = new Set([
  "SOURCE_BROADCAST_FAILED",
  "TOP_UP_BROADCAST_FAILED",
  "TOP_UP_REVERTED"
]);

// Scrub `message` so it carries the chain's diagnostic verbatim but
// doesn't leak internal-only strings: RPC URLs (provider identity) and
// any 0x-prefixed addresses that aren't already public on this payout's
// own row (source/destination/sponsor are already visible via API).
function sanitizeChainMessage(message: string, row: typeof payouts.$inferSelect): string {
  const ownAddresses = new Set(
    [row.sourceAddress, row.destinationAddress, row.topUpSponsorAddress]
      .filter((a): a is string => a !== null)
      .map((a) => a.toLowerCase())
  );
  return message
    // Replace http(s)://… URLs — usually the RPC endpoint.
    .replace(/https?:\/\/\S+/gi, "[rpc-url]")
    // Redact any foreign 0x-prefixed address; keep addresses that are
    // already public on this payout row.
    .replace(/0x[0-9a-fA-F]{40}/g, (m) =>
      ownAddresses.has(m.toLowerCase()) ? m : "[redacted-address]"
    );
}

// Stable, scrubbed strings persisted to `payouts.lastError` and surfaced
// to merchants via GET /payouts/:id and the payout.failed webhook. The raw
// underlying error (RPC URLs, addresses, internal libsql wrapper messages)
// stays in the operator log only.
const MERCHANT_FACING_FAIL_MESSAGES: Readonly<Record<PayoutErrorCode, string>> = {
  MERCHANT_NOT_FOUND: "Merchant not found.",
  MERCHANT_INACTIVE: "Merchant is inactive.",
  TOKEN_NOT_SUPPORTED: "Token not supported on this chain.",
  INVALID_DESTINATION: "Destination address is invalid for this chain.",
  BAD_AMOUNT: "Amount has more decimal places than the token supports.",
  ORACLE_FAILED: "Price oracle is unavailable; retry shortly.",
  INVALID_FEE_TIER: "Fee tier must be one of low / medium / high.",
  FEE_ESTIMATE_FAILED: "Could not quote gas; retry shortly.",
  BATCH_TOO_LARGE: "Batch exceeds the per-call cap.",
  INSUFFICIENT_BALANCE_ANY_SOURCE: "No HD source has enough balance to cover the payout.",
  NO_GAS_SPONSOR_AVAILABLE: "Token holder exists but no sponsor has enough native to top it up.",
  MAX_AMOUNT_EXCEEDS_NET_SPENDABLE: "Requested amount exceeds spendable balance after gas.",
  TOP_UP_BROADCAST_FAILED: "Gas top-up tx failed to broadcast; retry after operator intervention.",
  TOP_UP_REVERTED: "Gas top-up tx reverted on-chain.",
  SOURCE_BROADCAST_FAILED: "Main payout tx failed to broadcast.",
  PAYOUT_NOT_FOUND: "Payout not found.",
  PAYOUT_NOT_CANCELABLE: "Payout cannot be canceled in its current status."
};

const PAYOUT_ERROR_HTTP_STATUS: Readonly<Record<PayoutErrorCode, number>> = {
  MERCHANT_NOT_FOUND: 404,
  MERCHANT_INACTIVE: 403,
  TOKEN_NOT_SUPPORTED: 400,
  INVALID_DESTINATION: 400,
  BAD_AMOUNT: 400,
  ORACLE_FAILED: 503,
  INVALID_FEE_TIER: 400,
  FEE_ESTIMATE_FAILED: 503,
  BATCH_TOO_LARGE: 400,
  INSUFFICIENT_BALANCE_ANY_SOURCE: 503,
  NO_GAS_SPONSOR_AVAILABLE: 503,
  MAX_AMOUNT_EXCEEDS_NET_SPENDABLE: 400,
  TOP_UP_BROADCAST_FAILED: 503,
  TOP_UP_REVERTED: 500,
  SOURCE_BROADCAST_FAILED: 500,
  PAYOUT_NOT_FOUND: 404,
  PAYOUT_NOT_CANCELABLE: 409
};

export class PayoutError extends DomainError {
  declare readonly code: PayoutErrorCode;
  constructor(code: PayoutErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, PAYOUT_ERROR_HTTP_STATUS[code], details);
    this.name = "PayoutError";
  }
}

// SQLite's BEGIN IMMEDIATE takes the writer lock; a second concurrent
// writer fails fast with `SQLITE_BUSY` (the libsql client opens a fresh
// per-transaction connection so per-connection `busy_timeout` PRAGMAs
// don't stick). For the payout-plan transaction this would surface to
// the merchant as a flaky 5xx — wrap it in an exponential-backoff retry
// so concurrent plans serialize politely and the API stays predictable.
//
// Backoff schedule: 5ms, 15ms, 35ms, 75ms, 155ms (~285ms worst-case wait
// across 5 retries). Anything longer than that means real lock
// contention / a stuck transaction — surface SQLITE_BUSY to the caller
// rather than hang the request.
async function runWithBusyRetry<T>(
  deps: AppDeps,
  fn: () => Promise<T>
): Promise<T> {
  const delaysMs = [5, 15, 35, 75, 155];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= delaysMs.length) throw err;
      // Add ±50% jitter so two contending callers don't lockstep-retry
      // into each other indefinitely.
      const base = delaysMs[attempt]!;
      const jittered = base + Math.floor((Math.random() - 0.5) * base);
      deps.logger.debug("payout.plan.sqlite_busy_retry", { attempt: attempt + 1, delay: jittered });
      await new Promise((r) => setTimeout(r, jittered));
    }
  }
}

function isSqliteBusy(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  // Drizzle wraps DB errors in `Error("Failed query: ...", { cause: <libsql err> })`,
  // and libsql in turn wraps `better-sqlite3` errors in its own
  // `LibsqlError({ cause: SqliteError })`. SQLITE_BUSY can land on any layer.
  const e = err as { code?: unknown; rawCode?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === "string" && (e.code === "SQLITE_BUSY" || e.code === "SQLITE_BUSY_SNAPSHOT" || e.code === "SQLITE_LOCKED")) {
    return true;
  }
  // better-sqlite3's SqliteError uses numeric `rawCode`: 5 = SQLITE_BUSY, 6 = SQLITE_LOCKED.
  if (typeof e.rawCode === "number" && (e.rawCode === 5 || e.rawCode === 6)) {
    return true;
  }
  if (typeof e.message === "string" && /SQLITE_BUSY|database is locked/i.test(e.message)) {
    return true;
  }
  if (e.cause !== undefined) return isSqliteBusy(e.cause);
  return false;
}

// Convert a human-decimal string ("1.5") to the token's smallest-unit uint256
// string. BigInt math throughout — no floats.
function decimalToRaw(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) {
    throw new PayoutError(
      "BAD_AMOUNT",
      `amount has more than ${decimals} decimal places for this token`
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

// ---- Operations ----

export async function planPayout(deps: AppDeps, input: unknown): Promise<Payout> {
  const parsed = PlanPayoutInputSchema.parse(input);

  const [merchant] = await deps.db
    .select({ id: merchants.id, active: merchants.active })
    .from(merchants)
    .where(eq(merchants.id, parsed.merchantId))
    .limit(1);
  if (!merchant) throw new PayoutError("MERCHANT_NOT_FOUND", "Merchant not found");
  if (merchant.active !== 1) throw new PayoutError("MERCHANT_INACTIVE", "Merchant is inactive");

  const token = findToken(parsed.chainId, parsed.token);
  if (!token) {
    throw new PayoutError(
      "TOKEN_NOT_SUPPORTED",
      `Token ${parsed.token} not supported on chain ${parsed.chainId}`
    );
  }

  const chainAdapter = findChainAdapter(deps, parsed.chainId);
  let destination: string;
  try {
    destination = chainAdapter.canonicalizeAddress(parsed.destinationAddress);
  } catch {
    throw new PayoutError("INVALID_DESTINATION", `Invalid ${chainAdapter.family} address`);
  }
  if (!chainAdapter.validateAddress(destination)) {
    throw new PayoutError("INVALID_DESTINATION", `Invalid ${chainAdapter.family} address`);
  }

  if (parsed.webhookUrl !== undefined) {
    const envName = deps.secrets.getOptional("NODE_ENV");
    const allowHttp = envName === "development" || envName === "test";
    const safety = assertWebhookUrlSafe(parsed.webhookUrl, { allowHttp });
    if (!safety.ok) {
      throw new PayoutError(
        "INVALID_DESTINATION",
        `Per-payout webhookUrl rejected: ${safety.detail ?? safety.reason}`
      );
    }
  }

  let amountRaw: string;
  let quotedAmountUsd: string | null = null;
  let quotedRate: string | null = null;
  if (parsed.amountRaw !== undefined) {
    amountRaw = parsed.amountRaw;
  } else if (parsed.amount !== undefined) {
    amountRaw = decimalToRaw(parsed.amount, token.decimals);
  } else {
    let conversion: { amountRaw: string; rate: string };
    try {
      conversion = await deps.priceOracle.fiatToTokenAmount(
        parsed.amountUSD!,
        parsed.token,
        "USD" as Parameters<typeof deps.priceOracle.fiatToTokenAmount>[2],
        token.decimals
      );
    } catch (err) {
      throw new PayoutError(
        "ORACLE_FAILED",
        `Failed to fetch ${parsed.token}/USD rate: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    amountRaw = conversion.amountRaw;
    quotedAmountUsd = parsed.amountUSD!;
    quotedRate = conversion.rate;
  }

  let feeQuotedNative: string | null = null;
  if (parsed.feeTier !== undefined) {
    try {
      const tiers = await chainAdapter.quoteFeeTiers({
        chainId: parsed.chainId as ChainId,
        fromAddress: destination as Address,
        toAddress: destination as Address,
        token: parsed.token as TokenSymbol,
        amountRaw: amountRaw as AmountRaw
      });
      feeQuotedNative = tiers[parsed.feeTier].nativeAmountRaw;
    } catch (err) {
      deps.logger.warn("payout.plan.fee_tier_quote_failed", {
        chainId: parsed.chainId,
        token: parsed.token,
        feeTier: parsed.feeTier,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const webhookSecretCiphertext =
    parsed.webhookSecret !== undefined
      ? await deps.secretsCipher.encrypt(parsed.webhookSecret)
      : null;

  // Run source selection + reservation insert + payout insert atomically
  // under BEGIN IMMEDIATE. Without the immediate write lock, two parallel
  // plans on the same source can both observe "fits" and both insert,
  // over-reserving. The lock serializes reservation inserts globally —
  // OK because reservations are infrequent and millisecond-scale.
  //
  // Selection failures throw PayoutError synchronously; the merchant
  // gets an immediate, actionable response (INSUFFICIENT_BALANCE_ANY_SOURCE,
  // NO_GAS_SPONSOR_AVAILABLE, FEE_ESTIMATE_FAILED, MAX_AMOUNT_EXCEEDS_NET_SPENDABLE)
  // rather than a queued payout that fails on the next executor tick.

  // Gas estimate runs OUTSIDE the IMMEDIATE transaction. Adapter calls
  // hit the chain RPC and can take seconds under load; if that ran
  // inside the writer-locked transaction, the lock-hold time would
  // blow `runWithBusyRetry`'s retry budget (hundreds of ms) and starve
  // concurrent plans. The slight staleness vs. on-chain truth between
  // here and the broadcast is OK — the executor re-quotes at broadcast
  // time, and the picker only needs the estimate for relative
  // headroom comparisons against ledger balances.
  let gasNeeded: bigint;
  try {
    gasNeeded = BigInt(await chainAdapter.estimateGasForTransfer({
      chainId: parsed.chainId as ChainId,
      fromAddress: destination as Address,
      toAddress: destination as Address,
      token: parsed.token as TokenSymbol,
      amountRaw: amountRaw as AmountRaw
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn("payout.gas_estimate.failed", {
      chainId: parsed.chainId, token: parsed.token, error: message
    });
    throw new PayoutError(
      "FEE_ESTIMATE_FAILED",
      `Could not quote gas for chain ${parsed.chainId}. Retry shortly.`
    );
  }

  const now = deps.clock.now().getTime();
  const payoutId = globalThis.crypto.randomUUID();

  // Transaction returns a discriminated result instead of throwing, so
  // we can do error-enrichment work (oracle call for USD conversion)
  // OUTSIDE the IMMEDIATE writer lock. Throwing the enriched PayoutError
  // happens after the transaction rolls back or commits.
  type PlanResult =
    | { kind: "committed" }
    | { kind: "no_candidates" | "insufficient" | "no_sponsor" }
    | { kind: "max_send_exceeded"; suggestedAmountRaw: string };

  const result = await runWithBusyRetry(deps, () => deps.db.transaction(
    async (tx): Promise<PlanResult> => {
      // Insert the payout row FIRST so the reservation rows that
      // selectSource writes can satisfy the FK to payouts.id. We patch
      // sourceAddress / topUp* afterward once selection is known.
      await tx.insert(payouts).values({
        id: payoutId,
        merchantId: parsed.merchantId,
        kind: "standard",
        parentPayoutId: null,
        status: "reserved",
        chainId: parsed.chainId,
        token: parsed.token,
        amountRaw,
        quotedAmountUsd,
        quotedRate,
        feeTier: parsed.feeTier ?? null,
        feeQuotedNative,
        batchId: parsed.batchId ?? null,
        destinationAddress: destination,
        sourceAddress: null,
        txHash: null,
        feeEstimateNative: null,
        topUpTxHash: null,
        topUpSponsorAddress: null,
        topUpAmountRaw: null,
        lastError: null,
        createdAt: now,
        submittedAt: null,
        confirmedAt: null,
        updatedAt: now,
        webhookUrl: parsed.webhookUrl ?? null,
        webhookSecretCiphertext: webhookSecretCiphertext
      });

      const selection = await selectSource(deps, tx, chainAdapter, {
        payoutId,
        chainId: parsed.chainId,
        destinationAddress: destination,
        token: parsed.token,
        amountRaw,
        feeTier: parsed.feeTier ?? null,
        gasNeeded
      });

      if (
        selection.kind === "no_candidates" ||
        selection.kind === "insufficient" ||
        selection.kind === "no_sponsor" ||
        selection.kind === "max_send_exceeded"
      ) {
        // Throw to roll back the tentative payout insert + any
        // reservations selectSource wrote. The caller below maps the
        // result kind to a PayoutError after the oracle (USD enrichment)
        // returns — keeps the writer lock short.
        const err = new Error("__plan_rejected__") as Error & { planResult?: PlanResult };
        err.planResult = selection.kind === "max_send_exceeded"
          ? { kind: "max_send_exceeded", suggestedAmountRaw: selection.suggestedAmountRaw }
          : { kind: selection.kind };
        throw err;
      }

      // selection.kind === "direct" | "with_sponsor" — reservations are
      // already written into `tx`. Patch the payout row with the chosen
      // source and (when top-up is needed) the planned top-up amount.
      const topUpFields =
        selection.kind === "with_sponsor"
          ? { topUpAmountRaw: selection.topUpAmountRaw, topUpSponsorAddress: selection.sponsor.address }
          : {};

      await tx
        .update(payouts)
        .set({ sourceAddress: selection.source.address, ...topUpFields, updatedAt: now })
        .where(eq(payouts.id, payoutId));

      return { kind: "committed" };
    },
    { behavior: "immediate" }
  ).catch((err: unknown) => {
    // Unwrap our tunneled planResult; re-throw anything else (SQLITE_BUSY
    // etc. are handled by runWithBusyRetry; domain/system errors bubble).
    if (err && typeof err === "object" && "planResult" in err) {
      return (err as { planResult: PlanResult }).planResult;
    }
    throw err;
  }));

  // Post-transaction: map rejection kinds to enriched PayoutErrors.
  // Oracle calls (for USD) happen here, OUT of the writer lock window.
  if (result.kind === "no_candidates") {
    throw new PayoutError(
      "INSUFFICIENT_BALANCE_ANY_SOURCE",
      `No HD addresses are registered on chain ${parsed.chainId}. Initialize the address pool via POST /admin/pool/initialize.`
    );
  }
  if (result.kind === "insufficient") {
    throw new PayoutError(
      "INSUFFICIENT_BALANCE_ANY_SOURCE",
      `No HD address on chain ${parsed.chainId} has enough ${parsed.token} balance to cover the payout.`
    );
  }
  if (result.kind === "no_sponsor") {
    throw new PayoutError(
      "NO_GAS_SPONSOR_AVAILABLE",
      `Token holder exists on chain ${parsed.chainId} but no other HD address has enough native to top it up. Fund a sponsor address with the chain's native asset.`
    );
  }
  if (result.kind === "max_send_exceeded") {
    const details = await buildMaxSendDetails(deps, {
      token: parsed.token,
      decimals: token.decimals,
      suggestedRaw: BigInt(result.suggestedAmountRaw)
    });
    throw new PayoutError(
      "MAX_AMOUNT_EXCEEDS_NET_SPENDABLE",
      `Requested ${amountRaw} ${parsed.token} exceeds spendable native balance after gas. Try ${details.suggestedAmount} ${parsed.token} or less.`,
      details
    );
  }

  const row = await fetchPayout(deps, payoutId);
  if (!row) throw new Error(`planPayout: inserted row ${payoutId} disappeared`);

  // Emits `payout.planned` for backward compat with existing webhook
  // subscribers — the row's actual on-chain status starts at `reserved`
  // (skipping the legacy `planned` state entirely), but the event is
  // semantically "this payout has been accepted by the gateway."
  await deps.events.publish({ type: "payout.planned", payoutId: row.id, payout: row, at: new Date(now) });
  return row;
}

const PAYOUT_BATCH_MAX = 100;

export type PayoutBatchOutcome =
  | { index: number; status: "planned"; payout: Payout }
  | { index: number; status: "failed"; error: { code: string; message: string } };

export interface PlanPayoutBatchResult {
  batchId: string;
  results: PayoutBatchOutcome[];
  summary: { planned: number; failed: number };
}

export async function planPayoutBatch(
  deps: AppDeps,
  merchantId: string,
  payoutsInput: readonly unknown[]
): Promise<PlanPayoutBatchResult> {
  if (payoutsInput.length === 0) {
    return { batchId: "", results: [], summary: { planned: 0, failed: 0 } };
  }
  if (payoutsInput.length > PAYOUT_BATCH_MAX) {
    throw new PayoutError(
      "BATCH_TOO_LARGE",
      `Batch size ${payoutsInput.length} exceeds cap ${PAYOUT_BATCH_MAX}. Split into smaller batches.`
    );
  }

  const batchId = globalThis.crypto.randomUUID();
  const results: PayoutBatchOutcome[] = [];
  let planned = 0;
  let failed = 0;

  for (let i = 0; i < payoutsInput.length; i += 1) {
    const row = payoutsInput[i];
    try {
      const input = {
        ...((row as Record<string, unknown>) ?? {}),
        merchantId,
        batchId
      };
      const payout = await planPayout(deps, input);
      results.push({ index: i, status: "planned", payout });
      planned += 1;
    } catch (err) {
      if (err instanceof DomainError) {
        results.push({
          index: i,
          status: "failed",
          error: { code: err.code, message: err.message }
        });
      } else if (err instanceof z.ZodError) {
        results.push({
          index: i,
          status: "failed",
          error: { code: "VALIDATION_FAILED", message: err.issues.map((x) => x.message).join("; ") }
        });
      } else {
        results.push({
          index: i,
          status: "failed",
          error: {
            code: "INTERNAL",
            message: err instanceof Error ? err.message : String(err)
          }
        });
      }
      failed += 1;
    }
  }

  return { batchId, results, summary: { planned, failed } };
}

// ---- Estimate ----

export interface EstimatePayoutFeesInput {
  merchantId: string;
  chainId: number;
  token: string;
  amountRaw?: string;
  amount?: string;
  amountUSD?: string;
  destinationAddress: string;
  feeTier?: "low" | "medium" | "high";
}

export interface SourceCandidate {
  address: string;
  derivationIndex: number;
  tokenBalance: string;
  nativeBalance: string;
}

export interface EstimatePayoutFeesResult {
  amountRaw: string;
  quotedAmountUsd: string | null;
  quotedRate: string | null;
  tiers: {
    tieringSupported: boolean;
    nativeSymbol: string;
    low: { tier: "low"; nativeAmountRaw: string; usdAmount: string | null };
    medium: { tier: "medium"; nativeAmountRaw: string; usdAmount: string | null };
    high: { tier: "high"; nativeAmountRaw: string; usdAmount: string | null };
  };
  // The HD address the executor will use as the payout source. Picked
  // richest-first by token balance from `address_pool`. Null when no
  // candidate has enough token balance.
  source: SourceCandidate | null;
  // When the chosen source has token balance but lacks native gas, the
  // executor needs to top it up from another HD address first. Omitted
  // (undefined) when no top-up is required. `sponsor: null` signals that a
  // top-up is needed but no funded sponsor exists — payout will fail at
  // plan/execute time.
  topUp?: {
    required: true;
    sponsor: { address: string; nativeBalance: string } | null;
    amountRaw: string;
  };
  // Next-best candidates by token balance, capped at 4. Lets the operator
  // see the broader pool state without paginating.
  alternatives: readonly SourceCandidate[];
  warnings: string[];
}

export async function estimatePayoutFees(
  deps: AppDeps,
  input: unknown
): Promise<EstimatePayoutFeesResult> {
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
  let destination: string;
  try {
    destination = chainAdapter.canonicalizeAddress(parsed.destinationAddress);
  } catch {
    throw new PayoutError("INVALID_DESTINATION", `Invalid ${chainAdapter.family} address`);
  }
  if (!chainAdapter.validateAddress(destination)) {
    throw new PayoutError("INVALID_DESTINATION", `Invalid ${chainAdapter.family} address`);
  }

  // Resolve amountRaw + USD audit (same shape as planPayout).
  let amountRaw: string;
  let quotedAmountUsd: string | null = null;
  let quotedRate: string | null = null;
  if (parsed.amountRaw !== undefined) {
    amountRaw = parsed.amountRaw;
  } else if (parsed.amount !== undefined) {
    amountRaw = decimalToRaw(parsed.amount, token.decimals);
  } else {
    let conversion: { amountRaw: string; rate: string };
    try {
      conversion = await deps.priceOracle.fiatToTokenAmount(
        parsed.amountUSD!,
        parsed.token,
        "USD" as Parameters<typeof deps.priceOracle.fiatToTokenAmount>[2],
        token.decimals
      );
    } catch (err) {
      throw new PayoutError(
        "ORACLE_FAILED",
        `Failed to fetch ${parsed.token}/USD rate: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    amountRaw = conversion.amountRaw;
    quotedAmountUsd = parsed.amountUSD!;
    quotedRate = conversion.rate;
  }

  const warnings: string[] = [];
  const nativeSymbol = chainAdapter.nativeSymbol(parsed.chainId as ChainId);

  // Three-tier quote. Best-effort: a quoting failure surfaces as
  // `tieringSupported=false` plus zeroed entries + a warning rather than
  // blowing up the whole estimate.
  let tiers: EstimatePayoutFeesResult["tiers"];
  try {
    const raw = await chainAdapter.quoteFeeTiers({
      chainId: parsed.chainId as ChainId,
      fromAddress: destination as Address,
      toAddress: destination as Address,
      token: parsed.token as TokenSymbol,
      amountRaw: amountRaw as AmountRaw
    });
    const usdRates = await deps.priceOracle
      .getUsdRates([nativeSymbol as TokenSymbol])
      .catch(() => ({} as Record<string, string>));
    const nativeUsd = usdRates[nativeSymbol] ?? null;
    // Native decimals come from the token registry when available (handles
    // dev chain's 6-decimal DEV alongside the standard 18/9/6 family
    // defaults). Falls back to the family default when an exotic chain
    // isn't in the registry yet.
    const nativeTokenEntry = findToken(parsed.chainId, nativeSymbol as TokenSymbol);
    const nativeDecimals = nativeTokenEntry?.decimals ?? nativeDecimalsForFamily(chainAdapter.family);
    const usdFor = (rawAmt: string): string | null => {
      if (nativeUsd === null) return null;
      const dec = formatRawDecimal(rawAmt, nativeDecimals);
      return mulDecimal(dec, nativeUsd);
    };
    tiers = {
      tieringSupported: raw.tieringSupported,
      nativeSymbol,
      low: { tier: "low", nativeAmountRaw: raw.low.nativeAmountRaw, usdAmount: usdFor(raw.low.nativeAmountRaw) },
      medium: { tier: "medium", nativeAmountRaw: raw.medium.nativeAmountRaw, usdAmount: usdFor(raw.medium.nativeAmountRaw) },
      high: { tier: "high", nativeAmountRaw: raw.high.nativeAmountRaw, usdAmount: usdFor(raw.high.nativeAmountRaw) }
    };
  } catch (err) {
    warnings.push("fee_quote_unavailable");
    deps.logger.warn("payout.estimate.fee_quote_failed", {
      chainId: parsed.chainId,
      error: err instanceof Error ? err.message : String(err)
    });
    tiers = {
      tieringSupported: false,
      nativeSymbol,
      low: { tier: "low", nativeAmountRaw: "0", usdAmount: null },
      medium: { tier: "medium", nativeAmountRaw: "0", usdAmount: null },
      high: { tier: "high", nativeAmountRaw: "0", usdAmount: null }
    };
  }

  // Tier we'll plan against. Defaults to medium when unspecified.
  const targetTier = parsed.feeTier ?? "medium";
  const gasNeeded = BigInt(tiers[targetTier].nativeAmountRaw);

  // Discover candidate HD addresses on this chain's family.
  const family = chainAdapter.family;
  const poolRows = await deps.db
    .select({ address: addressPool.address, addressIndex: addressPool.addressIndex })
    .from(addressPool)
    .where(eq(addressPool.family, family));

  if (poolRows.length === 0) {
    warnings.push("no_source_address_has_sufficient_token_balance");
    return {
      amountRaw,
      quotedAmountUsd,
      quotedRate,
      tiers,
      source: null,
      alternatives: [],
      warnings
    };
  }

  // Spendable per candidate (token + native, both ledger-derived).
  const tokenSym = parsed.token;
  const isNativePayout = parsed.token === nativeSymbol;
  const enriched = await Promise.all(
    poolRows.map(async (p) => {
      const tokenBalance = await computeSpendable(deps, {
        chainId: parsed.chainId,
        address: p.address,
        token: tokenSym
      });
      const nativeBalance = isNativePayout
        ? tokenBalance
        : await computeSpendable(deps, {
            chainId: parsed.chainId,
            address: p.address,
            token: nativeSymbol
          });
      return {
        address: p.address,
        derivationIndex: p.addressIndex,
        tokenBalance,
        nativeBalance
      };
    })
  );

  const requiredAmount = BigInt(amountRaw);

  // Sort by token balance descending; richest token holder first.
  enriched.sort((a, b) => (a.tokenBalance < b.tokenBalance ? 1 : a.tokenBalance > b.tokenBalance ? -1 : 0));

  // Tier A: source has both token + native gas.
  const directNeed = isNativePayout ? requiredAmount + gasNeeded : requiredAmount;
  const directNative = isNativePayout ? requiredAmount + gasNeeded : gasNeeded;
  const direct = enriched.find(
    (e) => e.tokenBalance >= directNeed && e.nativeBalance >= directNative
  );
  if (direct) {
    return {
      amountRaw,
      quotedAmountUsd,
      quotedRate,
      tiers,
      source: serializeCandidate(direct),
      alternatives: enriched
        .filter((e) => e.address !== direct.address)
        .slice(0, 4)
        .map(serializeCandidate),
      warnings
    };
  }

  // Tier B: a source has the token but not enough gas.
  if (!isNativePayout) {
    const tokenHolder = enriched.find((e) => e.tokenBalance >= requiredAmount);
    if (tokenHolder) {
      const gap = gasNeeded - tokenHolder.nativeBalance;
      const cushion = (gasNeeded * 20n) / 100n;
      const topUpAmount = gap + cushion;
      // Sponsor needs enough native to send `topUpAmount` AND its own gas.
      const sponsorOwnGas = gasNeeded; // approximate the simple-transfer gas at the same tier
      const sponsor = enriched.find(
        (e) => e.address !== tokenHolder.address && e.nativeBalance >= topUpAmount + sponsorOwnGas
      );
      if (sponsor) {
        return {
          amountRaw,
          quotedAmountUsd,
          quotedRate,
          tiers,
          source: serializeCandidate(tokenHolder),
          topUp: {
            required: true,
            sponsor: { address: sponsor.address, nativeBalance: sponsor.nativeBalance.toString() },
            amountRaw: topUpAmount.toString()
          },
          alternatives: enriched
            .filter((e) => e.address !== tokenHolder.address && e.address !== sponsor.address)
            .slice(0, 4)
            .map(serializeCandidate),
          warnings
        };
      }
      // Token holder exists but no sponsor.
      warnings.push("no_gas_sponsor_available");
      return {
        amountRaw,
        quotedAmountUsd,
        quotedRate,
        tiers,
        source: serializeCandidate(tokenHolder),
        topUp: { required: true, sponsor: null, amountRaw: (gasNeeded - tokenHolder.nativeBalance).toString() },
        alternatives: enriched
          .filter((e) => e.address !== tokenHolder.address)
          .slice(0, 4)
          .map(serializeCandidate),
        warnings
      };
    }
  }

  // No qualifying candidate.
  // Native MAX-send hint: when a candidate has native ≈ amount but not
  // enough headroom for gas, suggest the spendable amount minus gas.
  if (isNativePayout && enriched.length > 0) {
    const richest = enriched[0]!;
    if (richest.nativeBalance >= gasNeeded && richest.nativeBalance < directNeed) {
      const suggested = richest.nativeBalance - gasNeeded;
      warnings.push("max_amount_exceeds_net_spendable");
      const details = await buildMaxSendDetails(deps, {
        token: parsed.token,
        decimals: token.decimals,
        suggestedRaw: suggested
      });
      throw new PayoutError(
        "MAX_AMOUNT_EXCEEDS_NET_SPENDABLE",
        `Requested ${requiredAmount} ${parsed.token} would exceed spendable native balance after gas. Try ${details.suggestedAmount} ${parsed.token} or less.`,
        details
      );
    }
  }

  warnings.push("no_source_address_has_sufficient_token_balance");
  return {
    amountRaw,
    quotedAmountUsd,
    quotedRate,
    tiers,
    source: null,
    alternatives: enriched.slice(0, 4).map(serializeCandidate),
    warnings
  };
}

function serializeCandidate(c: {
  address: string;
  derivationIndex: number;
  tokenBalance: bigint;
  nativeBalance: bigint;
}): SourceCandidate {
  return {
    address: c.address,
    derivationIndex: c.derivationIndex,
    tokenBalance: c.tokenBalance.toString(),
    nativeBalance: c.nativeBalance.toString()
  };
}

function nativeDecimalsForFamily(family: "evm" | "tron" | "solana"): number {
  switch (family) {
    case "evm": return 18;
    case "tron": return 6;
    case "solana": return 9;
  }
}

// Shape the `details` payload on MAX_AMOUNT_EXCEEDS_NET_SPENDABLE so the
// frontend can render all three presentations without re-computing on its
// side: the raw uint256 for programmatic fills, the human-decimal form
// for the "Send X instead" button text, and (best-effort) USD so the
// operator can sanity-check the suggestion. USD conversion is wrapped in
// try/catch — an oracle outage must not replace the useful native info
// with a 500.
async function buildMaxSendDetails(
  deps: AppDeps,
  args: { token: string; decimals: number; suggestedRaw: bigint }
): Promise<{ suggestedAmountRaw: string; suggestedAmount: string; suggestedAmountUsd: string | null }> {
  const suggestedAmountRaw = args.suggestedRaw.toString();
  const suggestedAmount = formatRawDecimal(suggestedAmountRaw, args.decimals);
  let suggestedAmountUsd: string | null = null;
  try {
    const rates = await deps.priceOracle.getUsdRates([args.token as TokenSymbol]);
    const rate = rates[args.token];
    if (typeof rate === "string" && rate !== "") {
      suggestedAmountUsd = mulDecimal(suggestedAmount, rate);
    }
  } catch {
    // Oracle unavailable — leave USD null, operator-facing hint still has
    // the raw + decimal forms to act on.
  }
  return { suggestedAmountRaw, suggestedAmount, suggestedAmountUsd };
}

function formatRawDecimal(raw: string, decimals: number): string {
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

// Multiply two decimal strings and format the result rounded half-up to
// 2 fractional digits — the canonical USD display shape used across the
// estimate / balance-snapshot surfaces. BigInt math throughout, no float
// precision loss; output always includes the ".00" suffix so downstream
// JSON serialization stays uniform.
export function mulDecimal(a: string, b: string): string {
  const SCALE = 1_000_000_000_000n; // 12 fractional digits — well above USD precision needs
  const scale = (s: string): bigint => {
    const [whole, frac = ""] = s.split(".");
    const padded = (frac + "0".repeat(12)).slice(0, 12);
    return BigInt(whole ?? "0") * SCALE + BigInt(padded || "0");
  };
  const product = (scale(a) * scale(b)) / SCALE;
  // Round half-up to 2 decimal places: add 0.5 in the third decimal place
  // (5_000_000_000 in 1e12 units), then floor-divide back down.
  const roundedHundredths = (product + 5_000_000_000n) / 10_000_000_000n;
  const whole = roundedHundredths / 100n;
  const frac = roundedHundredths % 100n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

// ---- Executor ----

export interface ExecuteSweepResult {
  attempted: number;
  submitted: number;
  failed: number;
  deferred: number;
}

export interface ExecuteReservedPayoutsOptions {
  maxBatch?: number;
}

const DEFAULT_PAYOUT_CONCURRENCY_PER_CHAIN = 16;

// Cron-triggered: advances `reserved` and `topping-up` rows toward
// submitted. Cross-chain runs in parallel; within a chain we cap at
// `payoutConcurrencyPerChain` (default 16) to stay under runtime
// subrequest budgets. `planned` is intentionally NOT scanned — it's a
// vestigial enum value left for backward compat; planPayout now skips
// straight to `reserved` after running selectSource synchronously.
export async function executeReservedPayouts(
  deps: AppDeps,
  opts: ExecuteReservedPayoutsOptions = {}
): Promise<ExecuteSweepResult> {
  const limit = opts.maxBatch ?? 200;
  const eligible = await deps.db
    .select()
    .from(payouts)
    .where(
      and(
        inArray(payouts.status, ["reserved", "topping-up"]),
        eq(payouts.kind, "standard")
      )
    )
    .orderBy(asc(payouts.createdAt))
    .limit(limit);

  if (eligible.length === 0) {
    return { attempted: 0, submitted: 0, failed: 0, deferred: 0 };
  }

  const byChain = new Map<number, (typeof eligible)[number][]>();
  for (const row of eligible) {
    const list = byChain.get(row.chainId) ?? [];
    list.push(row);
    byChain.set(row.chainId, list);
  }

  const cap = Math.max(1, deps.payoutConcurrencyPerChain ?? DEFAULT_PAYOUT_CONCURRENCY_PER_CHAIN);
  const counts = { submitted: 0, failed: 0, deferred: 0 };

  await Promise.all(
    Array.from(byChain.values()).map((rowsForChain) =>
      runWithConcurrencyCap(rowsForChain, cap, async (row) => {
        const outcome = await executeOnePayout(deps, row);
        counts[outcome] += 1;
      })
    )
  );

  return {
    attempted: eligible.length,
    submitted: counts.submitted,
    failed: counts.failed,
    deferred: counts.deferred
  };
}

async function runWithConcurrencyCap<T>(
  items: readonly T[],
  cap: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workerCount = Math.min(cap, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        await worker(items[i] as T);
      }
    })
  );
}

// State-machine entry. Routes by `row.status`:
//   reserved   -> if a sponsor reservation exists, broadcast top-up tx and
//                 transition to `topping-up`; otherwise broadcast main tx.
//   topping-up -> poll top-up confirmation; on confirmed, broadcast main tx;
//                 on revert, fail (cascades to sibling).
//
// `planned` is NOT handled here — the source-picker now runs synchronously
// at plan time inside an IMMEDIATE transaction, so a row that reaches the
// executor is already `reserved` (or `topping-up` after a previous tick).
async function executeOnePayout(
  deps: AppDeps,
  row: typeof payouts.$inferSelect
): Promise<"submitted" | "failed" | "deferred"> {
  const chainAdapter = findChainAdapter(deps, row.chainId);

  if (row.status === "topping-up") {
    return executeTopUp(deps, row);
  }

  // status === "reserved" (executor only fetches reserved + topping-up).
  if (row.sourceAddress === null) {
    // Defensive: planPayout always sets sourceAddress for a reserved row.
    return failPayout(
      deps, row, "SOURCE_BROADCAST_FAILED",
      "Internal: reserved payout has no source address"
    );
  }

  // Detect top-up requirement via the sponsor reservation that planPayout
  // wrote alongside the source reservation. Presence of a row with
  // role='top_up_sponsor' for this payoutId means we owe the source a
  // gas top-up before the main tx.
  const [sponsorReservation] = await deps.db
    .select({
      address: payoutReservations.address,
      amountRaw: payoutReservations.amountRaw
    })
    .from(payoutReservations)
    .where(
      and(
        eq(payoutReservations.payoutId, row.id),
        eq(payoutReservations.role, "top_up_sponsor"),
        isNull(payoutReservations.releasedAt)
      )
    )
    .limit(1);

  if (sponsorReservation) {
    return startTopUpFromReservation(deps, row, chainAdapter, sponsorReservation.address);
  }

  // Direct path — look up the source's HD index and broadcast the main tx.
  const [poolRow] = await deps.db
    .select({ addressIndex: addressPool.addressIndex })
    .from(addressPool)
    .where(
      and(
        eq(addressPool.family, chainAdapter.family),
        eq(addressPool.address, row.sourceAddress)
      )
    )
    .limit(1);
  if (!poolRow) {
    return failPayout(
      deps, row, "SOURCE_BROADCAST_FAILED",
      `Source ${row.sourceAddress} no longer exists in address_pool`
    );
  }
  return broadcastMain(deps, row, chainAdapter, {
    address: row.sourceAddress,
    derivationIndex: poolRow.addressIndex
  });
}

// Broadcast the gas top-up tx for a payout whose plan-time picker decided a
// top-up was needed. Reservations are already in place; we look up the
// sponsor's HD index and the planned `topUpAmountRaw` (set on the parent
// row at plan time), insert the sibling `gas_top_up` payout for ledger
// audit, broadcast, and transition the parent to `topping-up`. The next
// executor tick handles confirmation polling via `executeTopUp`.
async function startTopUpFromReservation(
  deps: AppDeps,
  parent: typeof payouts.$inferSelect,
  chainAdapter: ChainAdapter,
  sponsorAddress: string
): Promise<"submitted" | "failed" | "deferred"> {
  if (parent.topUpAmountRaw === null || parent.sourceAddress === null) {
    return failPayout(
      deps, parent, "TOP_UP_BROADCAST_FAILED",
      "Internal: reserved payout missing topUpAmountRaw or sourceAddress"
    );
  }

  // CAS-claim the broadcast slot via a status transition. Only one worker
  // can transition `reserved → topping-up` for a given row, so a second
  // concurrent executor tick processing the same row loses the CAS and
  // returns `deferred` without broadcasting. Without this guard, parallel
  // ticks would each insert a sibling and broadcast a duplicate top-up tx
  // from the sponsor.
  //
  // If the broadcast itself crashes after the CAS, the row is left in
  // `topping-up` with `topUpTxHash IS NULL`. The defensive check at the
  // top of `executeTopUp` catches that and fails the payout cleanly.
  const now = deps.clock.now().getTime();
  const [claim] = await deps.db
    .update(payouts)
    .set({ status: "topping-up", updatedAt: now })
    .where(and(eq(payouts.id, parent.id), eq(payouts.status, "reserved")))
    .returning({ id: payouts.id });
  if (!claim) {
    return "deferred";
  }

  // Sponsor's HD index for signing.
  const [sponsorPool] = await deps.db
    .select({ addressIndex: addressPool.addressIndex })
    .from(addressPool)
    .where(
      and(
        eq(addressPool.family, chainAdapter.family),
        eq(addressPool.address, sponsorAddress)
      )
    )
    .limit(1);
  if (!sponsorPool) {
    return failPayout(
      deps, parent, "TOP_UP_BROADCAST_FAILED",
      `Sponsor ${sponsorAddress} no longer exists in address_pool`
    );
  }

  const nativeSymbol = chainAdapter.nativeSymbol(parent.chainId as ChainId);
  const topUpId = globalThis.crypto.randomUUID();

  // Insert gas_top_up sibling payout (audit + ledger debit on confirm).
  await deps.db.insert(payouts).values({
    id: topUpId,
    merchantId: parent.merchantId,
    kind: "gas_top_up",
    parentPayoutId: parent.id,
    status: "reserved",
    chainId: parent.chainId,
    token: nativeSymbol,
    amountRaw: parent.topUpAmountRaw,
    quotedAmountUsd: null,
    quotedRate: null,
    feeTier: parent.feeTier,
    feeQuotedNative: null,
    batchId: null,
    destinationAddress: parent.sourceAddress,
    sourceAddress: sponsorAddress,
    txHash: null,
    feeEstimateNative: null,
    topUpTxHash: null,
    topUpSponsorAddress: null,
    topUpAmountRaw: null,
    lastError: null,
    createdAt: now,
    submittedAt: null,
    confirmedAt: null,
    updatedAt: now,
    webhookUrl: null,
    webhookSecretCiphertext: null
  });

  // Broadcast the top-up tx.
  let topUpTxHash: string;
  try {
    const unsigned = await chainAdapter.buildTransfer({
      chainId: parent.chainId,
      fromAddress: sponsorAddress,
      toAddress: parent.sourceAddress,
      token: nativeSymbol,
      amountRaw: parent.topUpAmountRaw as AmountRaw,
      ...(parent.feeTier !== null
        ? { feeTier: parent.feeTier as "low" | "medium" | "high" }
        : {})
    });
    const scope: SignerScope = {
      kind: "pool-address",
      family: chainAdapter.family,
      derivationIndex: sponsorPool.addressIndex
    };
    const privateKey = await deps.signerStore.get(scope);
    topUpTxHash = await chainAdapter.signAndBroadcast(unsigned, privateKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failPayout(
      deps, parent, "TOP_UP_BROADCAST_FAILED",
      `Top-up tx (${sponsorAddress} → ${parent.sourceAddress}) failed: ${message}`,
      topUpId
    );
  }

  const now2 = deps.clock.now().getTime();
  await deps.db
    .update(payouts)
    .set({ status: "submitted", txHash: topUpTxHash, submittedAt: now2, updatedAt: now2 })
    .where(eq(payouts.id, topUpId));
  // Status is already 'topping-up' from the CAS at the start; just fill in
  // the broadcast metadata so the next executor tick's polling has the
  // tx hash to query against.
  await deps.db
    .update(payouts)
    .set({
      topUpTxHash,
      topUpSponsorAddress: sponsorAddress,
      updatedAt: now2
    })
    .where(eq(payouts.id, parent.id));

  deps.logger.info("payout.top_up.broadcast", {
    payoutId: parent.id,
    topUpId,
    chainId: parent.chainId,
    sponsor: sponsorAddress,
    source: parent.sourceAddress,
    amount: parent.topUpAmountRaw,
    txHash: topUpTxHash
  });
  return "submitted";
}

// Re-entered when status === "topping-up". Polls the top-up tx via the
// chain adapter; on confirmation, broadcasts the main payout. On revert,
// fails the payout and releases reservations.
// Window between `startTopUpFromReservation`'s status CAS (reserved →
// topping-up) and the `topUpTxHash` write that follows broadcast. A
// second executor tick that fires during this window sees `topping-up`
// + `topUpTxHash IS NULL` and would mistakenly fail the payout. We
// give the broadcast 30s to finish before treating the null as a
// genuine crash. Real broadcast latency is sub-second; chain RPC
// timeouts are usually 10s. 30s is comfortably above both.
const TOP_UP_BROADCAST_GRACE_MS = 30_000;

async function executeTopUp(
  deps: AppDeps,
  row: typeof payouts.$inferSelect
): Promise<"submitted" | "failed" | "deferred"> {
  if (row.topUpTxHash === null) {
    // Two cases hit this branch:
    //   1. Another executor tick is currently mid-broadcast (the status
    //      flip has committed but the topUpTxHash write hasn't). Defer
    //      until the grace window expires; the ongoing broadcast will
    //      either succeed (write topUpTxHash, we recover next tick) or
    //      crash (we'll see no progress and fail after the grace).
    //   2. The tick that owned the broadcast actually crashed. After
    //      the grace window, no further progress is possible and we
    //      fail the payout cleanly.
    const ageMs = deps.clock.now().getTime() - row.updatedAt;
    if (ageMs < TOP_UP_BROADCAST_GRACE_MS) {
      return "deferred";
    }
    // Genuine crash — also fail any sibling that managed to land
    // before the crash so it doesn't sit in `reserved`/`submitted`
    // forever. Sibling may not exist if the crash hit before the
    // sibling insert.
    const [orphanSibling] = await deps.db
      .select({ id: payouts.id })
      .from(payouts)
      .where(and(eq(payouts.parentPayoutId, row.id), eq(payouts.kind, "gas_top_up")))
      .limit(1);
    return failPayout(
      deps,
      row,
      "TOP_UP_BROADCAST_FAILED",
      `Top-up broadcast did not complete within ${Math.round(TOP_UP_BROADCAST_GRACE_MS / 1000)}s grace; failing for operator triage.`,
      orphanSibling?.id
    );
  }
  const chainAdapter = findChainAdapter(deps, row.chainId);
  // Look up the sibling FIRST so revert + confirmed branches both have it.
  // The sibling is the gas_top_up payout row; on revert we cascade-fail it
  // alongside the parent so it doesn't sit in `submitted` forever (the
  // sweep watchdog would otherwise WARN about it indefinitely).
  const [sibling] = await deps.db
    .select()
    .from(payouts)
    .where(and(eq(payouts.parentPayoutId, row.id), eq(payouts.kind, "gas_top_up")))
    .limit(1);

  const status = await chainAdapter.getConfirmationStatus(row.chainId, row.topUpTxHash);
  if (status.reverted) {
    return failPayout(
      deps,
      row,
      "TOP_UP_REVERTED",
      `Top-up tx ${row.topUpTxHash} reverted on-chain.`,
      sibling?.id
    );
  }
  const threshold = confirmationThreshold(row.chainId, deps.confirmationThresholds);
  if (status.confirmations < threshold) {
    // Not confirmed yet — leave payout in topping-up; next tick re-checks.
    return "deferred";
  }
  // Top-up confirmed. Mark the gas_top_up sibling confirmed and release
  // the sponsor reservation. The sponsor reservation lives on the PARENT
  // payout's id with role='top_up_sponsor' (so the sibling row's
  // `sourceAddress` mirrors the sponsor for ledger debits, while the
  // reservation tracks "this parent has a sponsor in flight"). After the
  // top-up confirms, the sponsor's debit is captured by the sibling's
  // confirmed payout row — we can drop the reservation safely.
  const now = deps.clock.now().getTime();
  if (sibling) {
    const confirmStmt = deps.db
      .update(payouts)
      .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
      .where(eq(payouts.id, sibling.id));
    const releaseSponsorStmt = deps.db
      .update(payoutReservations)
      .set({ releasedAt: now })
      .where(
        and(
          eq(payoutReservations.payoutId, row.id),
          eq(payoutReservations.role, "top_up_sponsor"),
          isNull(payoutReservations.releasedAt)
        )
      );
    await deps.db.batch([confirmStmt, releaseSponsorStmt] as [
      typeof confirmStmt,
      typeof releaseSponsorStmt
    ]);
  }
  if (row.sourceAddress === null) {
    return failPayout(
      deps,
      row,
      "SOURCE_BROADCAST_FAILED",
      "Internal: payout in topping-up state with no recorded source address"
    );
  }

  // Pick up source's HD index from the address_pool (same as during selectSource).
  const [poolRow] = await deps.db
    .select({ addressIndex: addressPool.addressIndex })
    .from(addressPool)
    .where(
      and(
        eq(addressPool.family, chainAdapter.family),
        eq(addressPool.address, row.sourceAddress)
      )
    )
    .limit(1);
  if (!poolRow) {
    return failPayout(
      deps,
      row,
      "SOURCE_BROADCAST_FAILED",
      `Source ${row.sourceAddress} no longer exists in address_pool`
    );
  }
  return broadcastMain(deps, row, chainAdapter, {
    address: row.sourceAddress,
    derivationIndex: poolRow.addressIndex
  });
}

async function broadcastMain(
  deps: AppDeps,
  row: typeof payouts.$inferSelect,
  chainAdapter: ChainAdapter,
  source: { address: string; derivationIndex: number }
): Promise<"submitted" | "failed" | "deferred"> {
  // Broadcast-slot CAS — guards against:
  //   1. Double-send if a previous tick crashed after broadcast but
  //      before the status update (`broadcastAttemptedAt IS NULL`).
  //   2. Race against `cancelPayout`: a concurrent cancel that flipped
  //      status to `canceled` between executor scan and this point. The
  //      status check (`reserved` for direct path, `topping-up` for
  //      post-top-up path) ensures we never broadcast against a
  //      canceled row.
  const [broadcastClaim] = await deps.db
    .update(payouts)
    .set({ broadcastAttemptedAt: deps.clock.now().getTime() })
    .where(
      and(
        eq(payouts.id, row.id),
        isNull(payouts.broadcastAttemptedAt),
        inArray(payouts.status, ["reserved", "topping-up"])
      )
    )
    .returning({ id: payouts.id });
  if (!broadcastClaim) {
    return "deferred";
  }

  try {
    const unsigned = await chainAdapter.buildTransfer({
      chainId: row.chainId,
      fromAddress: source.address,
      toAddress: row.destinationAddress,
      token: row.token,
      amountRaw: row.amountRaw as AmountRaw,
      ...(row.feeTier !== null
        ? { feeTier: row.feeTier as "low" | "medium" | "high" }
        : {})
    });
    const scope: SignerScope = {
      kind: "pool-address",
      family: chainAdapter.family,
      derivationIndex: source.derivationIndex
    };
    const privateKey = await deps.signerStore.get(scope);
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
    return "submitted";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failPayout(deps, row, "SOURCE_BROADCAST_FAILED", message);
  }
}

// Move a payout to `failed`, release ALL of its reservation rows (the source
// reservation AND, when present, the sponsor reservation on a sibling
// gas_top_up). The sibling row itself is also marked failed if it exists.
//
// `lastError` is exposed to the merchant via GET /payouts/:id and the
// payout.failed webhook, so we sanitize it: persist a stable
// short message keyed on `code` rather than the raw `message` (which
// may carry RPC URLs, internal HD-pool addresses, libsql wrapper
// strings, etc.). The full message is logged at WARN for operator
// triage, so nothing is lost — it just doesn't leak to the merchant.
async function failPayout(
  deps: AppDeps,
  row: typeof payouts.$inferSelect,
  code: PayoutErrorCode,
  message: string,
  alsoFailSiblingId?: string
): Promise<"failed"> {
  const now = deps.clock.now().getTime();
  // Operator-facing log carries the full, raw message + ids.
  deps.logger.warn("payout.failed", {
    payoutId: row.id,
    chainId: row.chainId,
    code,
    detail: message.slice(0, 4096),
    siblingId: alsoFailSiblingId
  });
  // Merchant-facing lastError. For chain-reported failures we pass the
  // chain's diagnostic through (scrubbed for foreign addresses/URLs) —
  // the merchant needs "insufficient funds" vs. "nonce too low" to
  // act. For internal gateway states we use the stable short string.
  const lastError = CHAIN_REPORTED_ERROR_CODES.has(code)
    ? `[${code}] ${sanitizeChainMessage(message, row).slice(0, 512)}`
    : `[${code}] ${MERCHANT_FACING_FAIL_MESSAGES[code] ?? "Payout failed."}`;
  const failParentStmt = deps.db
    .update(payouts)
    .set({ status: "failed", lastError, updatedAt: now })
    .where(eq(payouts.id, row.id));
  const releaseParentStmt = releaseReservationsStmt(deps, row.id);
  if (alsoFailSiblingId !== undefined) {
    const failSiblingStmt = deps.db
      .update(payouts)
      .set({ status: "failed", lastError, updatedAt: now })
      .where(eq(payouts.id, alsoFailSiblingId));
    const releaseSiblingStmt = releaseReservationsStmt(deps, alsoFailSiblingId);
    await deps.db.batch([failParentStmt, releaseParentStmt, failSiblingStmt, releaseSiblingStmt] as [
      typeof failParentStmt,
      typeof releaseParentStmt,
      typeof failSiblingStmt,
      typeof releaseSiblingStmt
    ]);
  } else {
    await deps.db.batch([failParentStmt, releaseParentStmt] as [
      typeof failParentStmt,
      typeof releaseParentStmt
    ]);
  }

  const updated = await fetchPayout(deps, row.id);
  if (updated) {
    await deps.events.publish({
      type: "payout.failed",
      payoutId: updated.id,
      payout: updated,
      at: new Date(now)
    });
  }
  return "failed";
}

// ---- Confirmer ----

export interface ConfirmPayoutsResult {
  checked: number;
  confirmed: number;
  failed: number;
}

export interface ConfirmPayoutsOptions {
  maxBatch?: number;
}

// Cron-triggered: move submitted payouts (standard kind only — gas_top_up
// siblings are confirmed in `executeTopUp` synchronously) to confirmed or
// failed based on the chain's view of the tx.
export async function confirmPayouts(
  deps: AppDeps,
  opts: ConfirmPayoutsOptions = {}
): Promise<ConfirmPayoutsResult> {
  const limit = opts.maxBatch ?? 200;
  const submitted = await deps.db
    .select()
    .from(payouts)
    .where(and(eq(payouts.status, "submitted"), eq(payouts.kind, "standard")))
    .orderBy(asc(payouts.submittedAt))
    .limit(limit);

  const counts = { confirmed: 0, failed: 0 };
  const cap = Math.max(1, deps.payoutConcurrencyPerChain ?? DEFAULT_PAYOUT_CONCURRENCY_PER_CHAIN);
  await runWithConcurrencyCap(submitted, cap, async (row) => {
    if (!row.txHash) return;
    const chainAdapter = findChainAdapter(deps, row.chainId);
    const now = deps.clock.now().getTime();
    const threshold = confirmationThreshold(row.chainId, deps.confirmationThresholds);

    const status = await chainAdapter.getConfirmationStatus(row.chainId, row.txHash);

    if (status.reverted) {
      const failStmt = deps.db
        .update(payouts)
        .set({ status: "failed", lastError: "Transaction reverted on-chain", updatedAt: now })
        .where(eq(payouts.id, row.id));
      const releaseStmt = releaseReservationsStmt(deps, row.id);
      await deps.db.batch([failStmt, releaseStmt] as [typeof failStmt, typeof releaseStmt]);
      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({ type: "payout.failed", payoutId: updated.id, payout: updated, at: new Date(now) });
      }
      counts.failed += 1;
      return;
    }

    if (status.confirmations >= threshold) {
      const confirmStmt = deps.db
        .update(payouts)
        .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
        .where(eq(payouts.id, row.id));
      const releaseStmt = releaseReservationsStmt(deps, row.id);
      await deps.db.batch([confirmStmt, releaseStmt] as [typeof confirmStmt, typeof releaseStmt]);
      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({ type: "payout.confirmed", payoutId: updated.id, payout: updated, at: new Date(now) });
      }
      counts.confirmed += 1;
    }
  });

  return { checked: submitted.length, confirmed: counts.confirmed, failed: counts.failed };
}

export async function getPayout(deps: AppDeps, id: PayoutId): Promise<Payout | null> {
  return fetchPayout(deps, id);
}

// ---- Cancel ----

// Cancel a `reserved` payout — release its reservations and mark the row
// `canceled`. Cancellation is intentionally narrow: only `reserved` rows
// (and only when belonging to the calling merchant). Once a top-up has
// broadcast (`topping-up`) or the main tx has broadcast (`submitted`) the
// chain owns the funds; we can't take them back, so cancel is rejected.
//
// Idempotent: cancelling an already-canceled row returns the row without
// error. Cancelling a confirmed/failed row returns `PAYOUT_NOT_CANCELABLE`
// (HTTP 409) so the merchant gets a clear signal.
export async function cancelPayout(
  deps: AppDeps,
  args: { merchantId: string; payoutId: PayoutId }
): Promise<Payout> {
  const [existing] = await deps.db
    .select()
    .from(payouts)
    .where(eq(payouts.id, args.payoutId))
    .limit(1);
  if (!existing || existing.merchantId !== args.merchantId) {
    // Cross-merchant access surfaces as not-found, same as `GET /payouts/:id`.
    throw new PayoutError("PAYOUT_NOT_FOUND", `Payout ${args.payoutId} not found`);
  }
  if (existing.kind !== "standard") {
    // gas_top_up siblings are gateway-internal; merchants can't address them.
    throw new PayoutError("PAYOUT_NOT_FOUND", `Payout ${args.payoutId} not found`);
  }

  if (existing.status === "canceled") {
    // Idempotent — return the existing row.
    const row = await fetchPayout(deps, existing.id);
    if (!row) throw new Error(`cancelPayout: row ${existing.id} disappeared`);
    return row;
  }
  if (existing.status !== "reserved") {
    throw new PayoutError(
      "PAYOUT_NOT_CANCELABLE",
      `Payout is in status '${existing.status}' — only 'reserved' payouts can be canceled. Once a tx has broadcast on-chain, the gateway cannot recall it.`
    );
  }

  // Atomic CAS + release. Two concurrency windows are possible between
  // our SELECT above and the writes below:
  //   1. Executor flipped reserved → topping-up first. Our cancel CAS
  //      misses (zero rows changed); we MUST NOT release reservations
  //      because the broadcast is in flight.
  //   2. We win the CAS; the executor's broadcastMain CAS (now also
  //      gated on status='reserved' — see broadcastMain) will lose and
  //      return "deferred" without broadcasting.
  // We perform the cancel UPDATE first, check rows-affected, and only
  // run the release if we actually transitioned the status. The previous
  // version batched both unconditionally, which silently leaked the
  // sponsor reservation when the executor won the race.
  const now = deps.clock.now().getTime();
  const claimed = await deps.db
    .update(payouts)
    .set({ status: "canceled", updatedAt: now })
    .where(and(eq(payouts.id, existing.id), eq(payouts.status, "reserved")))
    .returning({ id: payouts.id });
  if (claimed.length === 0) {
    // Executor moved the row out of `reserved` between our SELECT and
    // our CAS. Re-read to get the actual current status for a clean
    // error message; reservations are NOT released — the broadcast that
    // raced us still owns them.
    const [now] = await deps.db
      .select({ status: payouts.status })
      .from(payouts)
      .where(eq(payouts.id, existing.id))
      .limit(1);
    throw new PayoutError(
      "PAYOUT_NOT_CANCELABLE",
      `Payout transitioned to '${now?.status ?? "unknown"}' between read and cancel attempt — broadcast is in flight, cannot recall.`
    );
  }

  // CAS won — release reservations.
  await deps.db.update(payoutReservations)
    .set({ releasedAt: now })
    .where(
      and(
        eq(payoutReservations.payoutId, existing.id),
        isNull(payoutReservations.releasedAt)
      )
    );

  const row = await fetchPayout(deps, existing.id);
  if (!row) throw new Error(`cancelPayout: row ${existing.id} disappeared`);
  // No `payout.canceled` event exists in the bus today; if a webhook
  // event for cancel is needed later, add it to the union and emit here.
  return row;
}

// ---- List / filter ----

const LIST_PAYOUTS_MAX_LIMIT = 100;

export const ListPayoutsInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    status: z
      .array(
        z.enum([
          "planned",
          "reserved",
          "topping-up",
          "submitted",
          "confirmed",
          "failed",
          "canceled"
        ])
      )
      .optional(),
    chainId: ChainIdSchema.optional(),
    token: TokenSymbolSchema.optional(),
    destinationAddress: z.string().min(1).max(128).optional(),
    sourceAddress: z.string().min(1).max(128).optional(),
    batchId: z.string().min(1).max(64).optional(),
    createdFrom: z.number().int().nonnegative().optional(),
    createdTo: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(LIST_PAYOUTS_MAX_LIMIT).default(25),
    offset: z.number().int().min(0).default(0)
  })
  .refine(
    (v) => v.createdFrom === undefined || v.createdTo === undefined || v.createdFrom <= v.createdTo,
    { message: "`createdFrom` must be <= `createdTo`" }
  );
export type ListPayoutsInput = z.infer<typeof ListPayoutsInputSchema>;

export interface ListPayoutsResult {
  payouts: readonly Payout[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export async function listPayouts(deps: AppDeps, input: unknown): Promise<ListPayoutsResult> {
  const parsed = ListPayoutsInputSchema.parse(input);

  // Default filter to merchant-facing rows. gas_top_up siblings are
  // gateway-internal and never appear in the merchant API.
  const conditions: SQL[] = [
    eq(payouts.merchantId, parsed.merchantId),
    eq(payouts.kind, "standard")
  ];
  if (parsed.status && parsed.status.length > 0) {
    conditions.push(inArray(payouts.status, parsed.status));
  }
  if (parsed.chainId !== undefined) conditions.push(eq(payouts.chainId, parsed.chainId));
  if (parsed.token !== undefined) conditions.push(eq(payouts.token, parsed.token));
  if (parsed.destinationAddress !== undefined) {
    conditions.push(eq(payouts.destinationAddress, parsed.destinationAddress));
  }
  if (parsed.sourceAddress !== undefined) {
    conditions.push(eq(payouts.sourceAddress, parsed.sourceAddress));
  }
  if (parsed.batchId !== undefined) {
    conditions.push(eq(payouts.batchId, parsed.batchId));
  }
  if (parsed.createdFrom !== undefined) conditions.push(gte(payouts.createdAt, parsed.createdFrom));
  if (parsed.createdTo !== undefined) conditions.push(lte(payouts.createdAt, parsed.createdTo));

  const rows = await deps.db
    .select()
    .from(payouts)
    .where(and(...conditions))
    .orderBy(desc(payouts.createdAt))
    .limit(parsed.limit + 1)
    .offset(parsed.offset);

  const hasMore = rows.length > parsed.limit;
  const page = hasMore ? rows.slice(0, parsed.limit) : rows;
  return {
    payouts: page.map(drizzleRowToPayout),
    limit: parsed.limit,
    offset: parsed.offset,
    hasMore
  };
}

// ---- Stuck-reservation watchdog ----

export interface PayoutReservationSweepResult {
  releasedTerminal: number;
  stuckPending: number;
}

export interface SweepStuckPayoutReservationsOptions {
  stuckThresholdMs?: number;
}

// Cron-triggered watchdog. Releases active reservations whose payout is
// already in a terminal state (defense-in-depth — the atomic batch in
// confirmPayouts/failPayout makes this normally a no-op), and logs WARN for
// reservations older than `stuckThresholdMs` whose payout is still in a
// non-terminal in-flight state.
export async function sweepStuckPayoutReservations(
  deps: AppDeps,
  opts: SweepStuckPayoutReservationsOptions = {}
): Promise<PayoutReservationSweepResult> {
  const stuckThresholdMs = opts.stuckThresholdMs ?? 30 * 60 * 1000;
  const now = deps.clock.now().getTime();

  const terminalRelease = await deps.db
    .update(payoutReservations)
    .set({ releasedAt: now })
    .where(
      and(
        isNull(payoutReservations.releasedAt),
        inArray(
          payoutReservations.payoutId,
          deps.db
            .select({ id: payouts.id })
            .from(payouts)
            .where(inArray(payouts.status, ["confirmed", "failed", "canceled"]))
        )
      )
    )
    .returning({ id: payoutReservations.id });

  const stuck = await deps.db
    .select({
      reservationId: payoutReservations.id,
      address: payoutReservations.address,
      payoutId: payoutReservations.payoutId,
      createdAt: payoutReservations.createdAt,
      payoutStatus: payouts.status
    })
    .from(payoutReservations)
    .innerJoin(payouts, eq(payouts.id, payoutReservations.payoutId))
    .where(
      and(
        isNull(payoutReservations.releasedAt),
        lt(payoutReservations.createdAt, now - stuckThresholdMs),
        inArray(payouts.status, ["reserved", "topping-up", "submitted"])
      )
    );

  for (const row of stuck) {
    deps.logger.warn("payout reservation stuck mid-flight; operator review required", {
      reservationId: row.reservationId,
      address: row.address,
      payoutId: row.payoutId,
      payoutStatus: row.payoutStatus,
      heldMinutes: Math.round((now - row.createdAt) / 60_000)
    });
  }

  return {
    releasedTerminal: terminalRelease.length,
    stuckPending: stuck.length
  };
}

// ---- Source selection (the heart of the new picker) ----

type PickedSource = { address: string; derivationIndex: number };

type SourceSelection =
  | { kind: "direct"; source: PickedSource }
  | { kind: "with_sponsor"; source: PickedSource; sponsor: PickedSource; topUpAmountRaw: string }
  | { kind: "no_sponsor"; source: PickedSource }
  | { kind: "insufficient" }
  | { kind: "no_candidates" }
  | { kind: "max_send_exceeded"; suggestedAmountRaw: string };

// Selection input — pulled out of the payout row so plan-time callers (who
// don't have a row yet) can invoke the picker without building a half-row
// fixture. payoutId is the reservation owner; selectSource INSERTs reservations
// against this id inside the supplied transaction.
//
// `gasNeeded` is computed by the caller BEFORE entering the IMMEDIATE
// transaction — gas estimation can be a multi-second RPC call, and holding
// the writer lock through it would starve concurrent plans (the
// `runWithBusyRetry` budget is hundreds of ms, not seconds). The trade-off:
// the estimate may be slightly stale by the time we use it, but the picker
// only needs it for relative comparison ("does this candidate have enough
// native?"), and the executor re-quotes at broadcast time anyway.
type SelectionArgs = {
  payoutId: string;
  chainId: number;
  destinationAddress: string;
  token: string;
  amountRaw: string;
  feeTier: "low" | "medium" | "high" | null;
  gasNeeded: bigint;
};

// Drizzle's transaction handle and the top-level Db both implement these
// methods. Typed as a union so callers can pass either; the picker never
// touches anything outside this surface.
type DbOrTx = AppDeps["db"] | Parameters<Parameters<AppDeps["db"]["transaction"]>[0]>[0];

// Find a source HD address with enough token balance and either enough
// native gas (direct) or a sponsor that can top it up. Writes reservation
// rows into `tx` so the read+insert is atomic under the caller's
// `BEGIN IMMEDIATE` lock — without that lock, two parallel plans on the
// same source can both observe "fits" and both insert, over-reserving.
//
// Returns a `SourceSelection` discriminated union; the caller is expected
// to map non-success kinds to PayoutError throws so the merchant gets an
// immediate, actionable response at plan time rather than discovering the
// failure on the next executor tick.
async function selectSource(
  deps: AppDeps,
  tx: DbOrTx,
  chainAdapter: ChainAdapter,
  args: SelectionArgs
): Promise<SourceSelection> {
  const family = chainAdapter.family;
  const nativeSymbol = chainAdapter.nativeSymbol(args.chainId as ChainId);
  const isNativePayout = args.token === nativeSymbol;
  const tokenSym = args.token;
  const requiredAmount = BigInt(args.amountRaw);
  const gasNeeded = args.gasNeeded;
  void deps; // logger no longer used inside selectSource (gas estimate moved out)

  const poolRows = await tx
    .select({ address: addressPool.address, addressIndex: addressPool.addressIndex })
    .from(addressPool)
    .where(eq(addressPool.family, family));

  if (poolRows.length === 0) return { kind: "no_candidates" };

  // Spendable per candidate.
  const enriched = await Promise.all(
    poolRows.map(async (p) => {
      const tokenBalance = await computeSpendable(tx, {
        chainId: args.chainId,
        address: p.address,
        token: tokenSym
      });
      const nativeBalance = isNativePayout
        ? tokenBalance
        : await computeSpendable(tx, {
            chainId: args.chainId,
            address: p.address,
            token: nativeSymbol
          });
      return {
        address: p.address,
        derivationIndex: p.addressIndex,
        tokenBalance,
        nativeBalance
      };
    })
  );
  // Richest token holder first.
  enriched.sort((a, b) => (a.tokenBalance < b.tokenBalance ? 1 : a.tokenBalance > b.tokenBalance ? -1 : 0));

  // Tier A: source has both.
  const directNeed = isNativePayout ? requiredAmount + gasNeeded : requiredAmount;
  const directNative = isNativePayout ? requiredAmount + gasNeeded : gasNeeded;
  for (const cand of enriched) {
    if (cand.tokenBalance < directNeed) continue;
    if (cand.nativeBalance < directNative) continue;
    await insertReservationsForDirect(
      deps, tx, args.payoutId, args.chainId, cand,
      requiredAmount, gasNeeded, tokenSym, nativeSymbol, isNativePayout
    );
    return { kind: "direct", source: { address: cand.address, derivationIndex: cand.derivationIndex } };
  }

  // Native payouts can't be topped up (gas IS the asset). Surface
  // MAX_AMOUNT_EXCEEDS_NET_SPENDABLE when the richest candidate is close
  // — gives the merchant a concrete suggested amount instead of a vague
  // "insufficient balance" message.
  if (isNativePayout) {
    const richest = enriched[0];
    if (richest && richest.nativeBalance >= gasNeeded && richest.nativeBalance < directNeed) {
      return {
        kind: "max_send_exceeded",
        suggestedAmountRaw: (richest.nativeBalance - gasNeeded).toString()
      };
    }
    return { kind: "insufficient" };
  }

  // Tier B: token holder + sponsor.
  const tokenHolder = enriched.find((e) => e.tokenBalance >= requiredAmount);
  if (!tokenHolder) return { kind: "insufficient" };

  const gap = gasNeeded - tokenHolder.nativeBalance;
  if (gap <= 0n) {
    // Token holder actually has enough native — tier A's filter must have
    // found it. We're here only on race or non-determinism; give up this
    // tick.
    return { kind: "insufficient" };
  }
  const cushion = (gasNeeded * 20n) / 100n;
  const topUpAmount = gap + cushion;
  const sponsorOwnGas = gasNeeded;

  for (const sponsor of enriched) {
    if (sponsor.address === tokenHolder.address) continue;
    if (sponsor.nativeBalance < topUpAmount + sponsorOwnGas) continue;
    await insertReservationsForTopUp(
      deps, tx, args.payoutId, args.chainId,
      tokenHolder, sponsor,
      requiredAmount, topUpAmount, sponsorOwnGas,
      tokenSym, nativeSymbol
    );
    return {
      kind: "with_sponsor",
      source: { address: tokenHolder.address, derivationIndex: tokenHolder.derivationIndex },
      sponsor: { address: sponsor.address, derivationIndex: sponsor.derivationIndex },
      topUpAmountRaw: topUpAmount.toString()
    };
  }

  return { kind: "no_sponsor", source: { address: tokenHolder.address, derivationIndex: tokenHolder.derivationIndex } };
}

// Insert reservation rows for a direct (no-top-up) payout. The IMMEDIATE
// transaction held by the caller serializes the read+insert against
// concurrent plans, so no per-candidate re-check + retry loop is needed.
async function insertReservationsForDirect(
  deps: AppDeps,
  tx: DbOrTx,
  payoutId: string,
  chainId: number,
  cand: { address: string; derivationIndex: number; tokenBalance: bigint; nativeBalance: bigint },
  requiredAmount: bigint,
  gasNeeded: bigint,
  tokenSym: string,
  nativeSymbol: string,
  isNativePayout: boolean
): Promise<void> {
  const now = deps.clock.now().getTime();
  // Token reservation (covers the payout amount on the token rail).
  await tx.insert(payoutReservations).values({
    id: globalThis.crypto.randomUUID(),
    payoutId,
    role: "source",
    chainId,
    address: cand.address,
    token: isNativePayout ? nativeSymbol : tokenSym,
    amountRaw: isNativePayout ? (requiredAmount + gasNeeded).toString() : requiredAmount.toString(),
    createdAt: now,
    releasedAt: null
  });
  // Native reservation when payout is token (gas debit). For native payouts
  // the single row above already covers amount + gas.
  if (!isNativePayout && gasNeeded > 0n) {
    await tx.insert(payoutReservations).values({
      id: globalThis.crypto.randomUUID(),
      payoutId,
      role: "source",
      chainId,
      address: cand.address,
      token: nativeSymbol,
      amountRaw: gasNeeded.toString(),
      createdAt: now,
      releasedAt: null
    });
  }
}

async function insertReservationsForTopUp(
  deps: AppDeps,
  tx: DbOrTx,
  payoutId: string,
  chainId: number,
  tokenHolder: { address: string; derivationIndex: number; tokenBalance: bigint; nativeBalance: bigint },
  sponsor: { address: string; derivationIndex: number; tokenBalance: bigint; nativeBalance: bigint },
  requiredAmount: bigint,
  topUpAmount: bigint,
  sponsorOwnGas: bigint,
  tokenSym: string,
  nativeSymbol: string
): Promise<void> {
  const now = deps.clock.now().getTime();
  // Source: token reservation.
  await tx.insert(payoutReservations).values({
    id: globalThis.crypto.randomUUID(),
    payoutId,
    role: "source",
    chainId,
    address: tokenHolder.address,
    token: tokenSym,
    amountRaw: requiredAmount.toString(),
    createdAt: now,
    releasedAt: null
  });
  // Sponsor: native reservation covering top-up amount + sponsor's own gas.
  await tx.insert(payoutReservations).values({
    id: globalThis.crypto.randomUUID(),
    payoutId,
    role: "top_up_sponsor",
    chainId,
    address: sponsor.address,
    token: nativeSymbol,
    amountRaw: (topUpAmount + sponsorOwnGas).toString(),
    createdAt: now,
    releasedAt: null
  });
}

// ---- Internals ----

async function fetchPayout(deps: AppDeps, id: string): Promise<Payout | null> {
  const [row] = await deps.db.select().from(payouts).where(eq(payouts.id, id)).limit(1);
  return row ? drizzleRowToPayout(row) : null;
}

function releaseReservationsStmt(deps: AppDeps, payoutId: string) {
  return deps.db
    .update(payoutReservations)
    .set({ releasedAt: deps.clock.now().getTime() })
    .where(
      and(
        eq(payoutReservations.payoutId, payoutId),
        isNull(payoutReservations.releasedAt)
      )
    );
}

