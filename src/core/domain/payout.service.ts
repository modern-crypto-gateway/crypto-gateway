import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, type SQL } from "drizzle-orm";
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

// Decimal-string regex used by `amount` and `amountUSD` paths. Strings only —
// JS numbers lose precision on monetary values. No leading zeros except "0",
// optional fractional part. Negatives + scientific notation rejected by shape.
const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;

export const PlanPayoutInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    chainId: ChainIdSchema,
    token: TokenSymbolSchema,
    // Three mutually-exclusive amount inputs. Exactly one must be provided.
    //   amountRaw — uint256 string in token's smallest unit (e.g. "1000000" for 1 USDC)
    //   amount    — human decimal string (e.g. "1.5"), parsed via BigInt against token.decimals
    //   amountUSD — fiat-pegged decimal string. Converted via priceOracle at create time;
    //               the resolved rate is snapshotted onto quoted_rate for audit.
    //               Supported on ALL tokens (stable + volatile). For non-stable tokens
    //               the broadcast may happen seconds-to-minutes later, so the executed
    //               payout's market value drifts from amountUSD — accepted as v1 cost.
    amountRaw: AmountRawSchema.optional(),
    amount: z.string().regex(DECIMAL_STRING, "amount must be a non-negative decimal string").optional(),
    amountUSD: z.string().regex(DECIMAL_STRING, "amountUSD must be a non-negative decimal string").optional(),
    // Optional fee tier hint. When set, EVM `buildTransfer` binds
    // maxFeePerGas / maxPriorityFeePerGas at this tier; other families
    // ignore. When unset, the executor uses the chain's default (medium-
    // equivalent on EVM, single-tier elsewhere).
    feeTier: z.enum(["low", "medium", "high"]).optional(),
    // Optional grouping id. Set by `planPayoutBatch` to the same value on
    // every row of a batch; ignored when posted directly on a single create
    // (the schema accepts it for uniformity but the normal `/` endpoint
    // doesn't expose batching).
    batchId: z.string().min(1).max(64).optional(),
    // Opt-in fallback: if no single fee wallet has enough balance for this
    // payout, the executor may split it across multiple wallets and broadcast
    // N parallel txs. Default false — the executor defers with
    // NO_FEE_WALLET_FUNDED and the operator tops up or retries with the flag.
    // Setting this to true does NOT force multi-source: single-source is
    // always attempted first, and multi-source only kicks in as a fallback.
    allowMultiSource: z.boolean().optional(),
    destinationAddress: z.string().min(1).max(128),

    // Per-payout webhook override. Both URL and secret must be provided
    // together — sending only one would dispatch events HMAC-signed with the
    // wrong key (or to the wrong URL with the merchant's key) and silently
    // break verification on the merchant's side. The secret is encrypted at
    // rest and never echoed in any API response.
    webhookUrl: z.string().url().optional(),
    webhookSecret: z.string().min(16).max(512).optional()
  })
  // Reject unknown keys. Prevents silent extra-field attacks where a future
  // refactor that adds a sensitive field could accidentally honor a value
  // the client slipped in before the field was defined.
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
  | "NO_FEE_WALLET_AVAILABLE"
  | "NO_FEE_WALLET_FUNDED"
  | "INVALID_FEE_TIER"
  | "FEE_ESTIMATE_FAILED"
  | "BATCH_TOO_LARGE"
  | "INSUFFICIENT_TOTAL_BALANCE";

const PAYOUT_ERROR_HTTP_STATUS: Readonly<Record<PayoutErrorCode, number>> = {
  MERCHANT_NOT_FOUND: 404,
  MERCHANT_INACTIVE: 403,
  TOKEN_NOT_SUPPORTED: 400,
  INVALID_DESTINATION: 400,
  BAD_AMOUNT: 400,
  ORACLE_FAILED: 503,
  NO_FEE_WALLET_AVAILABLE: 503,
  NO_FEE_WALLET_FUNDED: 503,
  INVALID_FEE_TIER: 400,
  FEE_ESTIMATE_FAILED: 503,
  BATCH_TOO_LARGE: 400,
  INSUFFICIENT_TOTAL_BALANCE: 503
};

export class PayoutError extends DomainError {
  declare readonly code: PayoutErrorCode;
  constructor(code: PayoutErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, PAYOUT_ERROR_HTTP_STATUS[code], details);
    this.name = "PayoutError";
  }
}

// Convert a human-decimal string ("1.5") to the token's smallest-unit uint256
// string. BigInt math throughout — no floats, no precision loss. Input format
// already validated by the schema regex; this only enforces the per-token
// decimals cap (e.g. "1.5555555" rejected for USDC which has 6 decimals max).
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
  // Generic error messages — don't echo the submitted merchantId back to the
  // caller. The value is already known to whoever holds the API key (it's
  // derivable from the key itself server-side), and echoing it in the
  // response just makes error-log scraping easier for any attacker with a
  // leaked key trying to probe for victim UUIDs.
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
  // Canonicalize FIRST, then validate the canonical form. If a merchant
  // sends a valid-but-non-canonical address (e.g., mixed-case EVM), this
  // keeps the stored value consistent with what the adapter will later
  // verify on-chain, and catches any case where canonicalize would produce
  // something validateAddress would reject on a second pass.
  let destination: string;
  try {
    destination = chainAdapter.canonicalizeAddress(parsed.destinationAddress);
  } catch {
    throw new PayoutError("INVALID_DESTINATION", `Invalid ${chainAdapter.family} address`);
  }
  if (!chainAdapter.validateAddress(destination)) {
    throw new PayoutError("INVALID_DESTINATION", `Invalid ${chainAdapter.family} address`);
  }

  // SSRF guard on the per-payout webhook override. Admin merchant-create
  // already runs this check on the merchant-default URL; payouts need their
  // own application of the same guard because an authenticated merchant
  // could otherwise point payout-event webhooks at internal metadata
  // endpoints (169.254.169.254/...) or loopback services running in the
  // gateway's VPC. `allowHttp` is the same dev/test escape hatch used by
  // admin: development and test envs can target http://localhost receivers.
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

  // Resolve the canonical `amountRaw` from whichever input shape was given.
  // Schema's refine already guaranteed exactly one is set.
  let amountRaw: string;
  let quotedAmountUsd: string | null = null;
  let quotedRate: string | null = null;
  if (parsed.amountRaw !== undefined) {
    amountRaw = parsed.amountRaw;
  } else if (parsed.amount !== undefined) {
    amountRaw = decimalToRaw(parsed.amount, token.decimals);
  } else {
    // amountUSD path — call the price oracle. A failure here surfaces as
    // 503 ORACLE_FAILED so the merchant can retry; we never silently
    // substitute a stale rate (no fallback by design — the merchant asked
    // for "this many dollars" and we either honor it at a known rate or
    // refuse the create).
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

  // When the merchant picked a specific fee tier at create time, snapshot
  // the quoted native-unit cost onto the row. Lets operators later compare
  // `feeQuotedNative` against the on-chain actual fee for drift analysis
  // (and lets dispute reconciliation answer "what was the merchant told
  // this would cost?"). Best-effort — tier quoting uses the chain's RPC and
  // can fail; a quoting failure here must not block the plan, so we log and
  // continue with null.
  let feeQuotedNative: string | null = null;
  if (parsed.feeTier !== undefined) {
    try {
      const tiers = await chainAdapter.quoteFeeTiers({
        chainId: parsed.chainId as ChainId,
        fromAddress: destination as Address, // placeholder; gas est is tx-payload-driven
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
    amountRaw,
    quotedAmountUsd,
    quotedRate,
    feeTier: parsed.feeTier ?? null,
    feeQuotedNative,
    batchId: parsed.batchId ?? null,
    allowMultiSource: parsed.allowMultiSource === true ? 1 : 0,
    sourceAddressesJson: null,
    txHashesJson: null,
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

// Maximum rows per batch. Keeps the per-request work bounded so a single
// batch can't starve the rate limiter or push the runtime past its
// subrequest budget. Larger queues should chunk client-side.
const PAYOUT_BATCH_MAX = 100;

export type PayoutBatchOutcome =
  | { index: number; status: "planned"; payout: Payout }
  | { index: number; status: "failed"; error: { code: string; message: string } };

export interface PlanPayoutBatchResult {
  batchId: string;
  results: PayoutBatchOutcome[];
  summary: { planned: number; failed: number };
}

// Plan up to `PAYOUT_BATCH_MAX` payouts in one call. Each row is validated
// and inserted independently inside a per-row try/catch — one bad row
// doesn't sink the whole batch. Every successfully-planned row carries the
// same `batchId` so operators can list them together later via
// `GET /api/v1/payouts?batchId=<id>`.
//
// Atomicity is PER-ROW: we don't wrap the whole batch in a single DB
// transaction because libSQL batch transactions don't span the non-DB work
// (price-oracle calls, adapter validation, signer) that planPayout does.
// Fail-open per-row is the safer default for mass payouts — partial success
// beats all-or-nothing here.
export async function planPayoutBatch(
  deps: AppDeps,
  merchantId: string,
  payoutsInput: readonly unknown[]
): Promise<PlanPayoutBatchResult> {
  if (payoutsInput.length === 0) {
    // Empty batch: don't even mint a batchId.
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
      // Merge in the batch-level merchantId and batchId. Accept-only semantics:
      // the merchant cannot override these from the body.
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

// Quote three fee tiers for a hypothetical payout WITHOUT planning anything
// or reserving a fee wallet. Operators call this from the dashboard before
// committing — the merchant picks a tier, then plans the payout with that
// tier set in the body. The price oracle converts each tier's native amount
// to USD for display; oracle failure is non-fatal here (the operator can
// still pick a tier knowing only the native cost).
//
// The fee wallet's `fromAddress` for the underlying gas estimate isn't known
// at this point (no CAS yet), so we use a placeholder address — gas estimates
// for straight transfers don't depend meaningfully on `from` for ERC-20 or
// native transfers. The actual broadcast re-estimates with the real wallet.
export interface EstimatePayoutFeesInput {
  merchantId: string;
  chainId: number;
  token: string;
  amountRaw?: string;
  amount?: string;
  amountUSD?: string;
  destinationAddress: string;
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
  // Current state of the fee wallet the executor is likely to reserve. Null
  // when NO active fee wallet exists for the chain (operator needs to
  // register one first via POST /admin/fee-wallets).
  feeWallet: {
    address: string;
    nativeSymbol: string;
    // Raw smallest-units. Null when the balance read failed (RPC flap).
    nativeBalance: string | null;
    tokenSymbol: string;
    tokenBalance: string | null;
  } | null;
  // How much the operator needs to top up the fee wallet for each tier to
  // land this specific payout. For native-token payouts this includes the
  // payout amount itself; for ERC-20/SPL/TRC-20 it's just gas. Null entries
  // mean "balance unknown, can't compute" (RPC flap).
  fundingRequired: {
    low: string | null;
    medium: string | null;
    high: string | null;
    nativeSymbol: string;
    note: string;
  } | null;
  // Non-fatal operator-facing notices. Empty when nothing's off-normal.
  // Examples: "fee_wallet_unfunded_used_fallback_gas" when we had to quote
  // without a live gas estimate, "no_fee_wallet_registered" when no wallet
  // exists at all, "rpc_balance_read_failed" when the balance check flapped.
  warnings: string[];
}

export async function estimatePayoutFees(
  deps: AppDeps,
  input: unknown
): Promise<EstimatePayoutFeesResult> {
  // Reuse PlanPayoutInputSchema for shape validation. We strip webhook fields
  // by passing only the relevant subset — the schema's refines on amount-key
  // exclusivity and merchant existence are exactly what we need here too.
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
    throw new PayoutError(
      "INVALID_DESTINATION",
      `Invalid ${chainAdapter.family} address: ${parsed.destinationAddress}`
    );
  }
  const destination = chainAdapter.canonicalizeAddress(parsed.destinationAddress);

  // Resolve amountRaw the same way planPayout does. USD-pegged path may fail
  // with ORACLE_FAILED; that's fine — the operator's best path is to retry.
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

  // Pick a placeholder fromAddress for gas estimation. We use the FIRST
  // active fee wallet on the chain if one exists (its derivation history
  // doesn't matter for gas estimation), else fall back to the destination
  // itself — gas estimates for straight transfers are address-insensitive
  // for the most part, and the broadcast re-estimates with the real wallet.
  const [sampleWallet] = await deps.db
    .select({ address: feeWallets.address })
    .from(feeWallets)
    .where(and(eq(feeWallets.chainId, parsed.chainId), eq(feeWallets.active, 1)))
    .limit(1);
  const fromForEstimate = (sampleWallet?.address ?? destination) as Address;

  const warnings: string[] = [];

  let tiers: Awaited<ReturnType<ChainAdapter["quoteFeeTiers"]>>;
  try {
    tiers = await chainAdapter.quoteFeeTiers({
      chainId: parsed.chainId as ChainId,
      fromAddress: fromForEstimate,
      toAddress: destination as Address,
      token: parsed.token as TokenSymbol,
      amountRaw: amountRaw as AmountRaw
    });
  } catch (err) {
    // Soft-fail. We used to throw FEE_ESTIMATE_FAILED (503) here, which
    // surfaced an unhelpful viem error string to the operator. Now we log
    // + warn, and return a best-effort tier quote of zero-native so the
    // frontend can still render a "couldn't quote fees live, fund the fee
    // wallet and retry" state. The broadcast path re-estimates against a
    // real funded wallet and succeeds there.
    deps.logger.warn("payout.estimate.quote_failed", {
      chainId: parsed.chainId,
      token: parsed.token,
      error: err instanceof Error ? err.message : String(err)
    });
    warnings.push("fee_quote_unavailable");
    const zero = "0" as AmountRaw;
    const nativeSym = chainAdapter.nativeSymbol(parsed.chainId as ChainId);
    tiers = {
      low: { tier: "low", nativeAmountRaw: zero },
      medium: { tier: "medium", nativeAmountRaw: zero },
      high: { tier: "high", nativeAmountRaw: zero },
      tieringSupported: false,
      nativeSymbol: nativeSym
    };
  }

  // Convert each tier's native amount to USD. Best-effort — oracle outage
  // here doesn't fail the whole estimate; we just return null usdAmount and
  // the operator gets to see the native cost.
  const decimalsForNative = token.symbol === tiers.nativeSymbol ? token.decimals : nativeDecimalsForFamily(chainAdapter.family);
  async function toUsd(nativeRaw: string): Promise<string | null> {
    try {
      const wholeNative = formatRawDecimal(nativeRaw, decimalsForNative);
      const rate = await deps.priceOracle.tokenToFiat(
        tiers.nativeSymbol as TokenSymbol,
        "USD" as Parameters<typeof deps.priceOracle.tokenToFiat>[1]
      );
      return mulDecimal(wholeNative, rate.rate);
    } catch {
      return null;
    }
  }

  const [lowUsd, midUsd, highUsd] = await Promise.all([
    toUsd(tiers.low.nativeAmountRaw),
    toUsd(tiers.medium.nativeAmountRaw),
    toUsd(tiers.high.nativeAmountRaw)
  ]);

  // Fee-wallet context: balance + funding-required calculation. If no
  // wallet is registered we still return tiers but flag it so the UI shows
  // "register a fee wallet first". For native-token payouts the required
  // fund includes the payout amount; for ERC-20/SPL/TRC-20 it's only gas.
  let feeWalletContext: EstimatePayoutFeesResult["feeWallet"] = null;
  let fundingRequired: EstimatePayoutFeesResult["fundingRequired"] = null;
  if (sampleWallet) {
    const tokenIsNative = parsed.token === tiers.nativeSymbol;
    const readBalance = async (sym: string): Promise<string | null> => {
      try {
        return await chainAdapter.getBalance({
          chainId: parsed.chainId as ChainId,
          address: sampleWallet.address as Address,
          token: sym as TokenSymbol
        });
      } catch (err) {
        deps.logger.debug("payout.estimate.balance_read_failed", {
          chainId: parsed.chainId,
          address: sampleWallet.address,
          token: sym,
          error: err instanceof Error ? err.message : String(err)
        });
        return null;
      }
    };
    const [nativeBalance, tokenBalance] = await Promise.all([
      readBalance(tiers.nativeSymbol),
      tokenIsNative ? Promise.resolve(null) : readBalance(parsed.token)
    ]);
    if (nativeBalance === null || (!tokenIsNative && tokenBalance === null)) {
      warnings.push("rpc_balance_read_failed");
    }
    if (nativeBalance !== null && BigInt(nativeBalance) === 0n) {
      warnings.push("fee_wallet_native_balance_zero");
    }
    feeWalletContext = {
      address: sampleWallet.address,
      nativeSymbol: tiers.nativeSymbol,
      nativeBalance,
      tokenSymbol: parsed.token,
      tokenBalance: tokenIsNative ? nativeBalance : tokenBalance
    };

    // Compute how much the operator needs to deposit to this wallet.
    if (nativeBalance !== null) {
      const currentNative = BigInt(nativeBalance);
      const amountBig = tokenIsNative ? BigInt(amountRaw) : 0n;
      const requiredFor = (tier: "low" | "medium" | "high"): string => {
        const fee = BigInt(tiers[tier].nativeAmountRaw);
        const totalNeeded = amountBig + fee;
        const shortfall = totalNeeded > currentNative ? totalNeeded - currentNative : 0n;
        return shortfall.toString();
      };
      fundingRequired = {
        low: requiredFor("low"),
        medium: requiredFor("medium"),
        high: requiredFor("high"),
        nativeSymbol: tiers.nativeSymbol,
        note: tokenIsNative
          ? `Native ${tiers.nativeSymbol} payout — the fee wallet needs payout amount + gas. Values shown are the SHORTFALL ("0" means already funded for that tier).`
          : `Token payout — the fee wallet needs gas only in native ${tiers.nativeSymbol}. Token balance is reported separately; top it up for the payout amount.`
      };
    }
  } else {
    warnings.push("no_fee_wallet_registered");
  }

  return {
    amountRaw,
    quotedAmountUsd,
    quotedRate,
    tiers: {
      tieringSupported: tiers.tieringSupported,
      nativeSymbol: tiers.nativeSymbol,
      low: { tier: "low", nativeAmountRaw: tiers.low.nativeAmountRaw, usdAmount: lowUsd },
      medium: { tier: "medium", nativeAmountRaw: tiers.medium.nativeAmountRaw, usdAmount: midUsd },
      high: { tier: "high", nativeAmountRaw: tiers.high.nativeAmountRaw, usdAmount: highUsd }
    },
    feeWallet: feeWalletContext,
    fundingRequired,
    warnings
  };
}

// Native decimals per family. Used by the estimate endpoint to convert the
// returned native amount into a USD figure via the priceOracle.
function nativeDecimalsForFamily(family: "evm" | "tron" | "solana"): number {
  if (family === "evm") return 18;
  if (family === "tron") return 6;
  return 9;
}

// Format a raw integer string as a decimal whole-units string at `decimals`
// precision. Mirrors the inverse of `decimalToRaw` above.
function formatRawDecimal(raw: string, decimals: number): string {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals);
  // Trim trailing zeros in the fractional part for a tidy display value;
  // priceOracle.tokenToFiat is decimal-safe regardless.
  const trimmedFrac = frac.replace(/0+$/, "");
  return trimmedFrac.length === 0 ? whole : `${whole}.${trimmedFrac}`;
}

// Multiply two non-negative decimal strings without floating-point loss.
// Used by the estimate endpoint to compute USD from native × USD/native.
// Always half-up rounds to 2 decimals — truncation produced systematic
// under-quoting (1000 ops × $0.005 drift = $5 invisible leak), and leading
// ".99" (empty wholePart) produced legally broken display strings.
//
// Exported for unit testing the edge cases that an earlier version missed.
export function mulDecimal(a: string, b: string): string {
  const aNorm = a.includes(".") ? a : `${a}.`;
  const bNorm = b.includes(".") ? b : `${b}.`;
  const [aWholeRaw, aFrac = ""] = aNorm.split(".");
  const [bWholeRaw, bFrac = ""] = bNorm.split(".");
  const aWhole = aWholeRaw === "" ? "0" : (aWholeRaw ?? "0");
  const bWhole = bWholeRaw === "" ? "0" : (bWholeRaw ?? "0");
  const aScaled = BigInt(aWhole + aFrac);
  const bScaled = BigInt(bWhole + bFrac);
  const product = aScaled * bScaled;
  const totalFracDigits = aFrac.length + bFrac.length;
  // Half-up round to 2 decimals. Take 3 digits past the decimal point, then
  // round based on the 3rd. This avoids the 0.001/2500.999 = $2.09 truncation
  // bug — correct rounded value is $2.50 (the full product is 2.502497499).
  const fullProductStr = product.toString().padStart(totalFracDigits + 1, "0");
  const wholePartRaw = totalFracDigits === 0 ? fullProductStr : fullProductStr.slice(0, -totalFracDigits);
  const fracFull = totalFracDigits === 0 ? "" : fullProductStr.slice(-totalFracDigits);
  const fracFor2dp = (fracFull + "000").slice(0, 3); // always 3 digits for rounding
  const firstTwo = fracFor2dp.slice(0, 2);
  const roundDigit = Number(fracFor2dp[2] ?? "0");
  let roundedWhole = wholePartRaw === "" ? "0" : wholePartRaw;
  let roundedFrac = firstTwo;
  if (roundDigit >= 5) {
    // Add 1 to the cents via BigInt to avoid carry bugs at boundaries.
    const centsRounded = BigInt(roundedWhole) * 100n + BigInt(firstTwo) + 1n;
    const cr = centsRounded.toString().padStart(3, "0");
    roundedWhole = cr.slice(0, -2);
    roundedFrac = cr.slice(-2);
  }
  // Guarantee a non-empty whole part for display stability.
  if (roundedWhole === "") roundedWhole = "0";
  return `${roundedWhole}.${roundedFrac}`;
}

// Register a fee wallet for a chain. Payouts on `chainId` will CAS-reserve from
// this pool. The matching private key is HD-derived on demand from MASTER_SEED
// at execution time — nothing is stored at rest.
export async function registerFeeWallet(
  deps: AppDeps,
  args: { chainId: number; address: string; label: string; derivationIndex: number }
): Promise<void> {
  const now = deps.clock.now().getTime();
  const chainAdapter = findChainAdapter(deps, args.chainId);
  const canonical = chainAdapter.canonicalizeAddress(args.address);
  // Refresh the label, derivation index, and active flag on conflict — the
  // caller is the source of truth on every register call. (Re-registering an
  // existing fee wallet at a NEW derivation index would be a serious
  // configuration error; the upstream admin handler should already have
  // derived the address from the supplied index, so the address column would
  // mismatch and trigger the unique constraint instead.)
  await deps.db
    .insert(feeWallets)
    .values({
      id: globalThis.crypto.randomUUID(),
      chainId: args.chainId,
      address: canonical,
      label: args.label,
      derivationIndex: args.derivationIndex,
      active: 1,
      reservedByPayoutId: null,
      reservedAt: null,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: [feeWallets.chainId, feeWallets.address],
      set: { label: args.label, derivationIndex: args.derivationIndex, active: 1 }
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

// Default cap when `deps.payoutConcurrencyPerChain` is unset. 16 fits well
// inside Cloudflare's ~50-subrequest budget per request when most ticks have
// 1-2 active chains; tune via env on busier deployments.
const DEFAULT_PAYOUT_CONCURRENCY_PER_CHAIN = 16;

// Tick-local balance cache. Scoped to one `executeReservedPayouts` call so
// concurrent workers on the same chain share one RPC-fetched value per
// `(chainId, address, token)` key instead of each worker re-querying. Entries
// live only for the duration of the executor tick; the next tick starts
// fresh. A cached `null` means the last read threw — callers treat that as
// "can't verify" and fall back to the post-reservation defensive check.
type BalanceCache = Map<string, Promise<bigint | null>>;
function balanceCacheKey(chainId: number, address: string, token: string): string {
  return `${chainId}:${address}:${token}`;
}

// Cron-triggered: promote planned payouts to submitted by CAS-reserving a fee
// wallet, building + signing + broadcasting the transfer. Cross-chain rows run
// in parallel (no shared resource); within a chain we cap concurrency so we
// don't blow the runtime's subrequest budget. The two CAS gates inside
// `executeOnePayout` (`tryReserveFeeWallet` + the broadcast-slot CAS) make
// concurrent calls on the same chain race-safe — losers naturally retry the
// next candidate or short-circuit to `deferred`.
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

  if (planned.length === 0) {
    return { attempted: 0, submitted: 0, failed: 0, deferred: 0 };
  }

  // Group by chainId so the per-chain concurrency cap is enforced
  // independently. Cross-chain runs in parallel via the outer Promise.all.
  const byChain = new Map<number, (typeof planned)[number][]>();
  for (const row of planned) {
    const list = byChain.get(row.chainId) ?? [];
    list.push(row);
    byChain.set(row.chainId, list);
  }

  const cap = Math.max(1, deps.payoutConcurrencyPerChain ?? DEFAULT_PAYOUT_CONCURRENCY_PER_CHAIN);
  const counts = { submitted: 0, failed: 0, deferred: 0 };
  // One balance cache per tick, shared across all workers. Multiple payouts
  // selecting from the same fee-wallet pool only pay one getBalance per
  // (wallet, token) pair.
  const balanceCache: BalanceCache = new Map();

  await Promise.all(
    Array.from(byChain.values()).map((rowsForChain) =>
      runWithConcurrencyCap(rowsForChain, cap, async (row) => {
        const outcome = await executeOnePayout(deps, row, balanceCache);
        counts[outcome] += 1;
      })
    )
  );

  return {
    attempted: planned.length,
    submitted: counts.submitted,
    failed: counts.failed,
    deferred: counts.deferred
  };
}

// Bounded worker pool. Pulls items off the front of the queue; each worker
// processes one at a time, returns to grab the next. Order within a chain
// stays roughly FIFO (older payouts start first) but completion order is not
// preserved — that's fine, each row's outcome is independent.
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

// Single-payout pipeline: CAS-reserve wallet -> claim broadcast slot ->
// balance pre-flight -> build/sign/broadcast. Returns the terminal outcome
// from the executor's perspective so the caller can tally without sharing
// state across workers. All persistence happens inside this function — the
// caller never touches the row.
async function executeOnePayout(
  deps: AppDeps,
  row: typeof payouts.$inferSelect,
  balanceCache: BalanceCache
): Promise<"submitted" | "failed" | "deferred"> {
  const chainAdapter = findChainAdapter(deps, row.chainId);

  // 1. Gas-aware CAS: pick a wallet that has both the token AND enough native
  //    gas, then CAS-claim it. The old "pick first available, check balance
  //    after" path churned through reserve→fail→release when the first row
  //    was short. Now we filter candidates before reserving so that "reserve,
  //    fail, release" is the exceptional case (RPC drift) rather than the
  //    common one.
  const wallet = await selectAndReserveFeeWallet(
    deps,
    row,
    chainAdapter,
    balanceCache
  );
  if (!wallet) {
    // Single-source wallet selection failed. If the operator opted into the
    // multi-source fallback, try splitting the amount across multiple
    // wallets. The multi-source path is a separate execution pipeline —
    // returns its own terminal outcome and we don't fall through to the
    // rest of this function.
    if (row.allowMultiSource === 1) {
      return executeMultiSourcePayout(deps, row, chainAdapter, balanceCache);
    }
    return "deferred";
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
    return "deferred";
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
      return "failed";
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
      amountRaw: row.amountRaw,
      ...(row.feeTier !== null
        ? { feeTier: row.feeTier as "low" | "medium" | "high" }
        : {})
    });

    const signerScope: SignerScope = feeWalletScope(
      chainAdapter,
      wallet.label,
      wallet.derivationIndex
    );
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
    return "submitted";
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
    return "failed";
  }
}

// Multi-source fallback pipeline. Invoked from `executeOnePayout` ONLY when:
//   1. `row.allowMultiSource === 1` (merchant opted in at create time), AND
//   2. Single-source selection returned null (no wallet had enough balance).
//
// Greedily picks the top-N wallets sorted by token balance desc until their
// cumulative balance clears the payout amount, CAS-reserves all of them,
// then broadcasts one tx per wallet covering a proportional slice. The row's
// status transitions planned → submitted in one shot; the per-leg tx hashes
// land in `tx_hashes_json` and the per-leg source addresses in
// `source_addresses_json`. Confirmation (see `confirmPayouts`) then waits
// for EVERY hash to cross the chain's confirmation threshold.
//
// On any broadcast failure: every reserved wallet is released, the payout
// flips to failed. Legs that already submitted on-chain before the failure
// become orphan outbound txs — operator reconciles via the `txHashes` field.
// This is intentional: we don't auto-refund or auto-retry partial
// broadcasts, because doing so would require reversing on-chain txs.
async function executeMultiSourcePayout(
  deps: AppDeps,
  row: typeof payouts.$inferSelect,
  chainAdapter: ChainAdapter,
  balanceCache: BalanceCache
): Promise<"submitted" | "failed" | "deferred"> {
  const requiredAmount = BigInt(row.amountRaw);
  const nativeSymbol = chainAdapter.nativeSymbol(row.chainId as ChainId);

  // Gather every active, unreserved wallet on this chain.
  const candidates = await deps.db
    .select({
      id: feeWallets.id,
      address: feeWallets.address,
      label: feeWallets.label,
      derivationIndex: feeWallets.derivationIndex
    })
    .from(feeWallets)
    .where(
      and(
        eq(feeWallets.chainId, row.chainId),
        eq(feeWallets.active, 1),
        isNull(feeWallets.reservedByPayoutId)
      )
    );
  if (candidates.length === 0) {
    deps.logger.debug("payout.multi_source.no_wallet_available", {
      payoutId: row.id,
      chainId: row.chainId
    });
    return "deferred";
  }

  // Fetch each candidate's token + native balance via the shared cache.
  const estimatedGas = await estimateGasOrFallback(chainAdapter, {
    chainId: row.chainId as ChainId,
    fromAddress: candidates[0]!.address as Address,
    toAddress: row.destinationAddress as Address,
    token: row.token as TokenSymbol,
    amountRaw: row.amountRaw as AmountRaw
  });
  const enriched = await Promise.all(
    candidates.map(async (c) => {
      const tokenBalance = await cachedGetBalance(
        deps,
        chainAdapter,
        balanceCache,
        row.chainId,
        c.address,
        row.token
      );
      if (tokenBalance === null || tokenBalance <= 0n) return null;
      const nativeBalance =
        row.token === nativeSymbol
          ? tokenBalance
          : await cachedGetBalance(
              deps,
              chainAdapter,
              balanceCache,
              row.chainId,
              c.address,
              nativeSymbol
            );
      if (nativeBalance === null || nativeBalance < estimatedGas) return null;
      return { ...c, tokenBalance };
    })
  );
  const funded = enriched
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => (a.tokenBalance < b.tokenBalance ? 1 : a.tokenBalance > b.tokenBalance ? -1 : 0));

  // Greedy pick: take wallets in descending balance until cumulative ≥ amount.
  // Also cap the leg count so we don't broadcast a pathological 50-tx
  // payout — more legs means more gas cost and more points of failure.
  const MAX_MULTI_SOURCE_LEGS = 8;
  type Leg = { wallet: (typeof funded)[number]; legAmount: bigint };
  const picked: Leg[] = [];
  let cumulative = 0n;
  for (const wallet of funded) {
    if (cumulative >= requiredAmount) break;
    if (picked.length >= MAX_MULTI_SOURCE_LEGS) break;
    const remaining = requiredAmount - cumulative;
    const legAmount = wallet.tokenBalance >= remaining ? remaining : wallet.tokenBalance;
    picked.push({ wallet, legAmount });
    cumulative += legAmount;
  }

  if (cumulative < requiredAmount) {
    // Even the sum of every funded wallet falls short. Hard-fail the payout
    // (don't defer) because no amount of waiting helps without the operator
    // topping up. INSUFFICIENT_TOTAL_BALANCE is the dedicated error code so
    // admin alerting distinguishes this from transient NO_FEE_WALLET_FUNDED.
    const now = deps.clock.now().getTime();
    const message = `Multi-source: available total ${cumulative} falls short of required ${requiredAmount} across ${funded.length} funded wallets`;
    await deps.db
      .update(payouts)
      .set({ status: "failed", lastError: message.slice(0, 2048), updatedAt: now })
      .where(eq(payouts.id, row.id));
    const updated = await fetchPayout(deps, row.id);
    if (updated) {
      await deps.events.publish({
        type: "payout.failed",
        payoutId: updated.id,
        payout: updated,
        at: new Date(now)
      });
    }
    deps.logger.warn("payout.multi_source.insufficient_total", {
      payoutId: row.id,
      chainId: row.chainId,
      required: requiredAmount.toString(),
      available: cumulative.toString(),
      walletCount: funded.length
    });
    return "failed";
  }

  // CAS-reserve every chosen wallet. If any loses the CAS, roll back the
  // already-reserved ones and defer the payout — a later tick retries.
  const nowReserve = deps.clock.now().getTime();
  const reserved: Leg[] = [];
  for (const leg of picked) {
    const [claim] = await deps.db
      .update(feeWallets)
      .set({ reservedByPayoutId: row.id, reservedAt: nowReserve })
      .where(and(eq(feeWallets.id, leg.wallet.id), isNull(feeWallets.reservedByPayoutId)))
      .returning({ id: feeWallets.id });
    if (!claim) {
      // Rollback reservations we already won.
      for (const w of reserved) {
        await deps.db
          .update(feeWallets)
          .set({ reservedByPayoutId: null, reservedAt: null })
          .where(and(eq(feeWallets.id, w.wallet.id), eq(feeWallets.reservedByPayoutId, row.id)));
      }
      return "deferred";
    }
    reserved.push(leg);
  }

  // Flip the payout to `reserved` and record the primary source (first leg).
  // The full list lands on `source_addresses_json` at submit time.
  const sourceAddresses = reserved.map((l) => l.wallet.address);
  await deps.db
    .update(payouts)
    .set({
      status: "reserved",
      sourceAddress: sourceAddresses[0] ?? null,
      sourceAddressesJson: JSON.stringify(sourceAddresses),
      updatedAt: nowReserve
    })
    .where(eq(payouts.id, row.id));

  // Broadcast-slot CAS — same as single-source. Guards against double-send
  // if the executor crashed after broadcast last tick.
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
    return "deferred";
  }

  // Build / sign / broadcast each leg in parallel. We use `allSettled`, not
  // `all`, so a failure in one leg doesn't discard the hashes of legs that
  // already landed on-chain. That audit trail is critical: if legs 1-3 went
  // out and leg 4 threw, legs 1-3 are LIVE txs the operator needs to see.
  // With `Promise.all` + catch we'd lose them silently.
  const settled = await Promise.allSettled(
    reserved.map(async (leg) => {
      const unsigned = await chainAdapter.buildTransfer({
        chainId: row.chainId,
        fromAddress: leg.wallet.address,
        toAddress: row.destinationAddress,
        token: row.token,
        amountRaw: leg.legAmount.toString() as AmountRaw,
        ...(row.feeTier !== null
          ? { feeTier: row.feeTier as "low" | "medium" | "high" }
          : {})
      });
      const signerScope: SignerScope = feeWalletScope(
        chainAdapter,
        leg.wallet.label,
        leg.wallet.derivationIndex
      );
      const privateKey = await deps.signerStore.get(signerScope);
      return chainAdapter.signAndBroadcast(unsigned, privateKey);
    })
  );

  const successfulHashes: string[] = [];
  const failures: Array<{ legIndex: number; sourceAddress: string; reason: string }> = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      successfulHashes.push(result.value as string);
    } else {
      const err = result.reason;
      failures.push({
        legIndex: i,
        sourceAddress: reserved[i]!.wallet.address,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  });

  const now2 = deps.clock.now().getTime();

  if (failures.length === 0) {
    // All legs broadcast successfully — standard submitted path.
    await deps.db
      .update(payouts)
      .set({
        status: "submitted",
        txHash: successfulHashes[0] ?? null,
        txHashesJson: JSON.stringify(successfulHashes),
        submittedAt: now2,
        updatedAt: now2
      })
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
    deps.logger.info("payout.multi_source.submitted", {
      payoutId: row.id,
      chainId: row.chainId,
      legs: reserved.length,
      required: requiredAmount.toString()
    });
    return "submitted";
  }

  // Partial or total broadcast failure. Persist the successful legs'
  // hashes so the operator has an audit trail for reconciliation — these
  // are LIVE on-chain txs that moved funds but didn't complete the payout
  // intent. lastError captures the first failure message plus a summary
  // of which legs landed on-chain; full structured detail is in the log.
  const firstReason = failures[0]?.reason ?? "multi-source broadcast failed";
  const summary = successfulHashes.length > 0
    ? `Multi-source partial failure: ${successfulHashes.length}/${reserved.length} legs broadcast successfully. ORPHAN TXS require manual reconciliation. First failure: ${firstReason}`
    : `Multi-source total failure: ${firstReason}`;

  const failStmt = deps.db
    .update(payouts)
    .set({
      status: "failed",
      lastError: summary.slice(0, 2048),
      // Even on failure, record the orphan tx hashes so the operator (and
      // ops dashboards that read the payout row) can see what landed.
      txHash: successfulHashes[0] ?? null,
      txHashesJson: successfulHashes.length > 0 ? JSON.stringify(successfulHashes) : null,
      updatedAt: now2
    })
    .where(eq(payouts.id, row.id));
  const releaseStmt = releaseFeeWalletStmt(deps, row.id);
  await deps.db.batch([failStmt, releaseStmt] as [typeof failStmt, typeof releaseStmt]);

  deps.logger.error("payout.multi_source.partial_failure", {
    payoutId: row.id,
    chainId: row.chainId,
    legsPlanned: reserved.length,
    legsSucceeded: successfulHashes.length,
    legsFailed: failures.length,
    orphanTxHashes: successfulHashes,
    failures
  });

  const updated = await fetchPayout(deps, row.id);
  if (updated) {
    await deps.events.publish({
      type: "payout.failed",
      payoutId: updated.id,
      payout: updated,
      at: new Date(now2)
    });
  }
  return "failed";
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

  const counts = { confirmed: 0, failed: 0 };
  // Process rows in parallel using the same bounded-concurrency runner used
  // by executeReservedPayouts. Pre-refactor this was a serial for-loop — at
  // 200 submitted rows × up to 8 multi-source legs × ~200ms per
  // `getConfirmationStatus` call, a worst-case tick could blow past the 30s
  // Workers CPU limit. Capping at the same per-chain concurrency
  // (payoutConcurrencyPerChain, default 16) keeps subrequest fan-out sane
  // while parallelizing the tick's wall-time.
  const cap = Math.max(1, deps.payoutConcurrencyPerChain ?? DEFAULT_PAYOUT_CONCURRENCY_PER_CHAIN);
  await runWithConcurrencyCap(submitted, cap, async (row) => {
    if (!row.txHash) return;
    const chainAdapter = findChainAdapter(deps, row.chainId);
    const now = deps.clock.now().getTime();
    const threshold = confirmationThreshold(row.chainId, deps.confirmationThresholds);

    // Multi-source payouts stash every leg's hash in `tx_hashes_json`. The
    // payout is confirmed only when ALL legs cross the threshold; a single
    // reverted leg fails the whole payout (operator reconciles the others
    // manually via `txHashes`). Single-source rows have `tx_hashes_json=null`
    // and fall through to the single-hash path unchanged.
    const hashes = parseHashArray(row.txHashesJson) ?? [row.txHash];

    const statuses = await Promise.all(
      hashes.map((h) => chainAdapter.getConfirmationStatus(row.chainId, h))
    );

    const anyReverted = statuses.some((s) => s.reverted);
    if (anyReverted) {
      const revertedHashIdx = statuses.findIndex((s) => s.reverted);
      const lastError =
        hashes.length > 1
          ? `Multi-source leg ${revertedHashIdx + 1}/${hashes.length} (${hashes[revertedHashIdx]}) reverted on-chain`
          : "Transaction reverted on-chain";
      const failStmt = deps.db
        .update(payouts)
        .set({ status: "failed", lastError, updatedAt: now })
        .where(eq(payouts.id, row.id));
      const releaseStmt = releaseFeeWalletStmt(deps, row.id);
      await deps.db.batch([failStmt, releaseStmt] as [typeof failStmt, typeof releaseStmt]);
      const updated = await fetchPayout(deps, row.id);
      if (updated) {
        await deps.events.publish({ type: "payout.failed", payoutId: updated.id, payout: updated, at: new Date(now) });
      }
      counts.failed += 1;
      return;
    }

    const allConfirmed = statuses.every((s) => s.confirmations >= threshold);
    if (allConfirmed) {
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
      counts.confirmed += 1;
    }
  });

  return { checked: submitted.length, confirmed: counts.confirmed, failed: counts.failed };
}

function parseHashArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const strs = parsed.filter((x): x is string => typeof x === "string");
    return strs.length > 0 ? strs : null;
  } catch {
    return null;
  }
}

export async function getPayout(deps: AppDeps, id: PayoutId): Promise<Payout | null> {
  return fetchPayout(deps, id);
}

// ---- List / filter ----

// Ceiling mirrors invoices: a single page stays bounded regardless of what
// the caller asks for. No receive-address hydration here, so payouts can
// afford the same 100-row ceiling without a fan-out cost.
const LIST_PAYOUTS_MAX_LIMIT = 100;

export const ListPayoutsInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    status: z
      .array(z.enum(["planned", "reserved", "submitted", "confirmed", "failed", "canceled"]))
      .optional(),
    chainId: ChainIdSchema.optional(),
    token: TokenSymbolSchema.optional(),
    // Where the payout is going. Exact match on the canonicalized address —
    // HTTP layer canonicalizes before calling.
    destinationAddress: z.string().min(1).max(128).optional(),
    // Which fee wallet the payout was funded from. NULL until `reserved`, so
    // this filter also implicitly excludes `planned` rows when set.
    sourceAddress: z.string().min(1).max(128).optional(),
    // Return only payouts belonging to a specific batch (from POST /batch).
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

// Merchant-scoped payout listing. Sort: createdAt DESC, backed by
// `idx_payouts_merchant` on (merchantId, createdAt DESC). All filters hit
// native columns on the payouts table — no JOINs needed.
export async function listPayouts(deps: AppDeps, input: unknown): Promise<ListPayoutsResult> {
  const parsed = ListPayoutsInputSchema.parse(input);

  const conditions: SQL[] = [eq(payouts.merchantId, parsed.merchantId)];
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

// Gas-aware fee-wallet selection. Replaces the older "pick first available"
// flow with a filter-then-tight-fit choice: we only reserve a wallet that
// already has the requested token AND enough native gas to pay the broadcast
// fee, and among qualifying wallets we pick the one whose token balance is
// the smallest above the payout amount. That tight-fit bias keeps
// large-balance wallets free for future big payouts instead of stranding
// them on small ones.
//
// Cache semantics: `balanceCache` is shared across all workers in a single
// `executeReservedPayouts` tick. A `(chainId, address, token)` triple is
// fetched at most once per tick. Stale values within a tick are acceptable
// (the post-reservation defensive check at step 4 of executeOnePayout
// catches RPC drift between selection and broadcast).
//
// CAS retry: we fetch a batch of qualifying candidates in one sort and try
// CAS on each in order until one sticks. On CAS loss, we move to the next
// candidate without re-querying balances (they were already fresh within
// this tick). If every filtered candidate loses CAS, we re-query once — a
// racing worker may have released a different wallet by then.
const FEE_WALLET_CAS_MAX_ATTEMPTS = 16;

type WalletCandidate = {
  id: string;
  address: string;
  label: string;
  derivationIndex: number;
};
type RankedCandidate = WalletCandidate & {
  tokenBalance: bigint;
  nativeBalance: bigint;
};

async function selectAndReserveFeeWallet(
  deps: AppDeps,
  row: typeof payouts.$inferSelect,
  chainAdapter: ChainAdapter,
  balanceCache: BalanceCache
): Promise<WalletCandidate | null> {
  const now = deps.clock.now().getTime();
  const requiredAmount = BigInt(row.amountRaw);
  const nativeSymbol = chainAdapter.nativeSymbol(row.chainId as ChainId);

  for (let outerAttempt = 0; outerAttempt < 2; outerAttempt += 1) {
    const candidates = await deps.db
      .select({
        id: feeWallets.id,
        address: feeWallets.address,
        label: feeWallets.label,
        derivationIndex: feeWallets.derivationIndex
      })
      .from(feeWallets)
      .where(
        and(
          eq(feeWallets.chainId, row.chainId),
          eq(feeWallets.active, 1),
          isNull(feeWallets.reservedByPayoutId)
        )
      )
      .limit(FEE_WALLET_CAS_MAX_ATTEMPTS);

    if (candidates.length === 0) {
      // Zero wallets registered or every one currently reserved. The caller
      // turns this into `deferred` and the next tick retries.
      deps.logger.debug("payout.execute.no_wallet_available", {
        payoutId: row.id,
        chainId: row.chainId
      });
      return null;
    }

    // Estimate gas once per tick per payout — the outbound tx shape is
    // fixed (from this payout's amount + destination). We use a placeholder
    // `fromAddress` of the first candidate for estimation; gas estimates
    // are deterministic on tx payload, not source address, for straight
    // transfers. If the adapter throws (not implemented), treat gas need
    // as zero so native-balance filtering is a no-op for that chain.
    const estimatedGas = await estimateGasOrFallback(chainAdapter, {
      chainId: row.chainId as ChainId,
      fromAddress: candidates[0]!.address as Address,
      toAddress: row.destinationAddress as Address,
      token: row.token as TokenSymbol,
      amountRaw: row.amountRaw as AmountRaw
    });

    // Fetch token + native balance for every candidate in parallel, via the
    // tick-local cache. Errors become `null` in the cache and disqualify the
    // candidate from this selection pass.
    const ranked = await Promise.all(
      candidates.map(async (c): Promise<RankedCandidate | null> => {
        const tokenBalance = await cachedGetBalance(
          deps,
          chainAdapter,
          balanceCache,
          row.chainId,
          c.address,
          row.token
        );
        if (tokenBalance === null || tokenBalance < requiredAmount) return null;
        // Same-symbol short-circuit: if the payout token IS the chain native
        // (ETH on Arbitrum, TRX on Tron, etc.), the one balance read covers
        // both checks. We still need gas headroom on top of the payout amount.
        const nativeBalance =
          row.token === nativeSymbol
            ? tokenBalance
            : await cachedGetBalance(
                deps,
                chainAdapter,
                balanceCache,
                row.chainId,
                c.address,
                nativeSymbol
              );
        if (nativeBalance === null) return null;
        const nativeNeeded =
          row.token === nativeSymbol ? requiredAmount + estimatedGas : estimatedGas;
        if (nativeBalance < nativeNeeded) return null;
        return { ...c, tokenBalance, nativeBalance };
      })
    );

    const qualifying = ranked.filter((c): c is RankedCandidate => c !== null);
    if (qualifying.length === 0) {
      // Candidates exist but none have enough token+gas. This is actionable
      // for the operator (top up) — differentiated from "no wallets at all".
      deps.logger.warn("payout.execute.no_wallet_funded", {
        payoutId: row.id,
        chainId: row.chainId,
        token: row.token,
        candidateCount: candidates.length,
        requiredAmount: row.amountRaw,
        estimatedGas: estimatedGas.toString()
      });
      return null;
    }

    // Tight-fit: smallest token balance above the payout amount. Ties broken
    // by ascending id for determinism so tests and logs are reproducible.
    qualifying.sort((a, b) => {
      const diff = a.tokenBalance - b.tokenBalance;
      if (diff < 0n) return -1;
      if (diff > 0n) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    for (const candidate of qualifying) {
      const [claim] = await deps.db
        .update(feeWallets)
        .set({ reservedByPayoutId: row.id, reservedAt: now })
        .where(and(eq(feeWallets.id, candidate.id), isNull(feeWallets.reservedByPayoutId)))
        .returning({
          id: feeWallets.id,
          address: feeWallets.address,
          label: feeWallets.label,
          derivationIndex: feeWallets.derivationIndex
        });
      if (claim) return claim;
      // CAS lost to a racing worker; try the next-best candidate.
    }
    // All qualifying candidates lost CAS. Refresh once in case some in-flight
    // payouts completed during this pass and released their wallets; the
    // outer loop bound (2) caps RPC work.
  }
  return null;
}

// Wrap `estimateGasForTransfer` so adapters that don't implement it (or throw
// on specific inputs) don't poison the entire selection path. A zero return
// means "don't filter by native balance on this chain" — correct for the dev
// adapter and for families where gas estimation is handled upstream.
async function estimateGasOrFallback(
  chainAdapter: ChainAdapter,
  args: Parameters<ChainAdapter["estimateGasForTransfer"]>[0]
): Promise<bigint> {
  try {
    const raw = await chainAdapter.estimateGasForTransfer(args);
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

// Shared-promise cache. The FIRST caller for a `(chainId, address, token)`
// creates the promise and stores it; concurrent callers await the same
// promise. Errors are materialized as `null` rather than rejecting so callers
// can simply filter them out — a failed read shouldn't bubble up and kill an
// otherwise-viable wallet selection.
async function cachedGetBalance(
  deps: AppDeps,
  chainAdapter: ChainAdapter,
  cache: BalanceCache,
  chainId: number,
  address: string,
  token: string
): Promise<bigint | null> {
  const key = balanceCacheKey(chainId, address, token);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const promise = chainAdapter
    .getBalance({
      chainId: chainId as ChainId,
      address: address as Address,
      token: token as TokenSymbol
    })
    .then(
      (raw) => {
        try {
          return BigInt(raw);
        } catch {
          return null;
        }
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.debug("payout.execute.balance_read_failed", {
          chainId,
          address,
          token,
          error: message
        });
        return null;
      }
    );
  cache.set(key, promise);
  return promise;
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

function feeWalletScope(
  chainAdapter: ChainAdapter,
  label: string,
  derivationIndex?: number
): SignerScope {
  const scope: SignerScope = { kind: "fee-wallet", family: chainAdapter.family, label };
  if (derivationIndex !== undefined) {
    scope.derivationIndex = derivationIndex;
  }
  return scope;
}
