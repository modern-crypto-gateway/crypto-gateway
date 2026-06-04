import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { ChainIdSchema, type ChainId } from "../types/chain.js";
import { AmountRawSchema } from "../types/money.js";
import { TokenSymbolSchema, type TokenSymbol } from "../types/token.js";
import { addressPool, payouts } from "../../db/schema.js";
import { findChainAdapter } from "./chain-lookup.js";
import { findToken } from "../types/token-registry.js";
import { computeSpendable } from "./balance-snapshot.service.js";
import { planPayout, PayoutError } from "./payout.service.js";

// Pool consolidation defragments a token balance that's split across many
// HD pool addresses into one designated target address, so a subsequent
// merchant payout (which on account-model chains can only pick a single
// sender) can draw from the consolidated balance.
//
// The flow reuses the regular payout machinery: each consolidation leg is
// inserted as a `kind: "consolidation_sweep"` row under the sentinel
// system merchant, ridden by the same executor cron through top-up →
// broadcast → confirmation. From a code-reuse standpoint we just have to
// (a) call planPayout once per source with the right flags and (b) tag
// the legs with a shared `batchId` so callers can poll group status.
//
// We deliberately don't add a new "consolidation" parent table. A bag of
// `consolidation_sweep` rows sharing a batchId is enough: aggregating
// status across the bag is a single query, and avoiding the new table
// keeps the cancel/reissue surface area unchanged.

// Sentinel merchant inserted by migration 0002. consolidation_sweep rows
// reference this id to satisfy the merchants FK without relaxing its
// NOT NULL constraint. Hardcoded here and in the migration; both must
// match. The all-f UUID is chosen to avoid colliding with the all-zero
// UUID that admin tests use as the "definitely-unknown id → 404" probe.
export const SYSTEM_INTERNAL_MERCHANT_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export const PlanConsolidationInputSchema = z
  .object({
    chainId: ChainIdSchema,
    token: TokenSymbolSchema,
    // The pool address that will receive all the consolidated balances.
    // Must already exist in `address_pool` for the chain's family.
    targetAddress: z.string().min(1).max(128),
    // Optional per-source-address dust floor: skip any pool address whose
    // spendable token balance is below this value. Used by the auto-
    // consolidation cron to avoid burning gas on dust addresses where the
    // per-tx gas cost would exceed the value being recovered. Decimal
    // string in the token's smallest unit (e.g. "10000000" = 10 USDT @
    // 6 decimals). Omit / set to "0" to consolidate every non-zero source.
    minSourceBalanceRaw: AmountRawSchema.optional(),
    // Optional cap on the number of legs planned in this single call.
    // Sources are processed in pool-iteration order (insertion order from
    // the address_pool select); the rest are silently deferred to the
    // caller's next invocation. Used by the auto-consolidation cron to
    // bound per-tick cost (Workers ~30s CPU budget). Omit for no cap.
    maxSources: z.number().int().positive().max(200).optional()
  })
  .strict();
export type PlanConsolidationInput = z.infer<typeof PlanConsolidationInputSchema>;

export interface ConsolidationLeg {
  readonly payoutId: string;
  readonly sourceAddress: string;
  readonly amountRaw: string;
}

export interface ConsolidationSkip {
  readonly sourceAddress: string;
  readonly amountRaw: string;
  readonly reason: string;
}

export interface ConsolidationPlanResult {
  readonly consolidationId: string;
  readonly chainId: number;
  readonly token: string;
  readonly targetAddress: string;
  // Legs that were successfully planned + reserved (status will be
  // 'reserved' or 'topping-up' until the executor advances them).
  readonly legs: readonly ConsolidationLeg[];
  // Sources we identified as having a token balance but couldn't plan a
  // sweep for — most often because no gas sponsor is available for that
  // particular leg (the registered fee wallet ran dry, or no pool address
  // has enough native to top them up). Surface these so the operator
  // knows why some balances stayed put. Each entry is INFORMATIONAL — the
  // overall consolidation request itself succeeded for the legs that
  // could be planned.
  readonly skipped: readonly ConsolidationSkip[];
}

export class ConsolidationError extends Error {
  readonly code:
    | "INVALID_CHAIN"
    | "INVALID_TOKEN"
    | "TARGET_NOT_IN_POOL"
    | "NO_SOURCES_WITH_BALANCE";
  constructor(code: ConsolidationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const HTTP_STATUS_BY_CODE: Readonly<Record<ConsolidationError["code"], number>> = {
  INVALID_CHAIN: 400,
  INVALID_TOKEN: 400,
  TARGET_NOT_IN_POOL: 400,
  NO_SOURCES_WITH_BALANCE: 400
};

export function consolidationErrorStatus(code: ConsolidationError["code"]): number {
  return HTTP_STATUS_BY_CODE[code];
}

// Drizzle wraps DB errors in `Error("Failed query: <sql>\nparams: <vals>", { cause: <libsql err> })`,
// and libsql in turn wraps the inner driver error. The OUTER message is just
// the rendered SQL — useful for debugging but useless as a leg-skip reason
// since it never says WHY the query failed (constraint violation? FK
// violation? CHECK?). Walk the cause chain and surface the deepest message
// that looks like an actual SQLite diagnostic. Fall back to the full chain
// concatenated so we never silently swallow a useful detail.
function formatLegError(err: unknown): string {
  if (err instanceof PayoutError) return `${err.code}: ${err.message}`;
  if (!(err instanceof Error)) return String(err);

  const messages: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current instanceof Error && depth < 6) {
    const e = current as Error & { code?: unknown; rawCode?: unknown };
    let line = current.message;
    if (typeof e.code === "string") line = `${e.code}: ${line}`;
    else if (typeof e.rawCode === "number") line = `rawCode=${e.rawCode}: ${line}`;
    messages.push(line);
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  // Prefer the LAST (innermost) message when it actually carries an SQLite
  // diagnostic; the outer "Failed query" wrapper is rarely the right answer
  // for an operator triaging a skipped leg.
  const sqliteIdx = messages.findIndex((m) =>
    /constraint failed|CHECK constraint|FOREIGN KEY constraint|NOT NULL constraint|UNIQUE constraint|SQLITE_/i.test(m)
  );
  if (sqliteIdx >= 0) return messages[sqliteIdx]!;
  return messages.join(" | ");
}

// Convert a native-gas cost into a token-denominated dust floor:
//   floorRaw = nativeRaw × (nativeUsd / tokenUsd) × 10^(tokenDec − nativeDec) × multiplier
// All BigInt; USD rates are scaled to micro-USD integers (6 dp is ample for an
// order-of-magnitude dust threshold). Best-effort: returns 0n (→ caller falls
// back to the static floor) on any missing rate or failure. Never throws.
async function nativeGasToTokenFloor(
  deps: AppDeps,
  args: {
    readonly nativeSymbol: string;
    readonly nativeRaw: bigint;
    readonly nativeDecimals: number;
    readonly token: string;
    readonly tokenDecimals: number;
    readonly multiplier: number;
  }
): Promise<bigint> {
  try {
    const rates = await deps.priceOracle.getUsdRates([
      args.nativeSymbol as TokenSymbol,
      args.token as TokenSymbol
    ]);
    const nativeUsdMicro = usdToMicro(rates[args.nativeSymbol]);
    const tokenUsdMicro = usdToMicro(rates[args.token]);
    if (nativeUsdMicro <= 0n || tokenUsdMicro <= 0n) return 0n;
    // multiplier (possibly fractional) → per-thousand integer to stay in BigInt.
    const multMilli = BigInt(Math.max(0, Math.round(args.multiplier * 1000)));
    const num = args.nativeRaw * nativeUsdMicro * pow10(args.tokenDecimals) * multMilli;
    const den = tokenUsdMicro * pow10(args.nativeDecimals) * 1000n;
    if (den === 0n) return 0n;
    return num / den;
  } catch {
    return 0n;
  }
}

// Parse a decimal USD-rate string ("2500.50") to a micro-USD integer. Tolerant
// of undefined/junk → 0n (caller treats as "no floor").
function usdToMicro(rate: string | undefined): bigint {
  if (rate === undefined) return 0n;
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return 0n;
  return BigInt(Math.round(n * 1_000_000));
}

function pow10(n: number): bigint {
  return 10n ** BigInt(Math.max(0, Math.trunc(n)));
}

export async function planPoolConsolidation(
  deps: AppDeps,
  input: unknown
): Promise<ConsolidationPlanResult> {
  const parsed = PlanConsolidationInputSchema.parse(input);

  // Chain + token validation — fail loud BEFORE creating any rows so a
  // typo doesn't leave a dangling consolidationId with zero legs.
  let chainAdapter;
  try {
    chainAdapter = findChainAdapter(deps, parsed.chainId);
  } catch {
    throw new ConsolidationError(
      "INVALID_CHAIN",
      `No chain adapter wired for chainId ${parsed.chainId}.`
    );
  }
  const tokenInfo = findToken(parsed.chainId, parsed.token);
  if (!tokenInfo) {
    throw new ConsolidationError(
      "INVALID_TOKEN",
      `Token ${parsed.token} is not registered on chain ${parsed.chainId}.`
    );
  }

  // Target must be a pool row on the same family, otherwise the executor
  // can't address it for ledger / signing purposes (the admin can still
  // hand-fund any address out-of-band; consolidation is specifically for
  // pool defrag).
  const family = chainAdapter.family;
  const [targetRow] = await deps.db
    .select({ address: addressPool.address })
    .from(addressPool)
    .where(
      and(
        eq(addressPool.family, family),
        eq(addressPool.address, parsed.targetAddress)
      )
    )
    .limit(1);
  if (!targetRow) {
    throw new ConsolidationError(
      "TARGET_NOT_IN_POOL",
      `Target address ${parsed.targetAddress} is not in the ${family} address pool.`
    );
  }

  // Discover sources with token balance > 0. Cross-check against the
  // ledger via computeSpendable (same source of truth selectSource uses)
  // so we don't try to consolidate a balance that's already pre-reserved
  // by another in-flight payout. Loaded sequentially to keep DB pressure
  // bounded; pool sizes are O(100s), not millions.
  const allPoolRows = await deps.db
    .select({ address: addressPool.address })
    .from(addressPool)
    .where(eq(addressPool.family, family));

  // Fee tier for internal sweeps (Lever 1). These move funds between
  // addresses we own — no merchant SLA — so we ride the cheapest tier by
  // default. The tier flows to planPayout below (and through it to the EVM
  // gas top-up sibling), and it's the basis for the gas-aware dust floor so
  // the floor matches what the sweep will actually pay. No-op on Tron.
  const internalTier = deps.internalConsolidationFeeTier ?? "low";

  // Static per-source dust floor. Defaults to 1 (i.e. "any non-zero balance"
  // — preserves the manual endpoint's pre-extension behavior when the caller
  // omits the field). Auto-consolidation passes a chain-/token-appropriate
  // value. Combined below with a gas-aware dynamic floor via max().
  const staticFloor = parsed.minSourceBalanceRaw !== undefined
    ? BigInt(parsed.minSourceBalanceRaw)
    : 1n;

  const isNativeConsolidation = tokenInfo.contractAddress === null;

  // Quote the per-sweep gas ONCE, at the tier we'll actually broadcast at, so
  // both the native sweep buffer and the dust floor use real numbers. This is
  // REQUIRED for native consolidation (we must know the gas to leave behind)
  // but only best-effort for token consolidation (the dust floor degrades to
  // the static floor if the quote is unavailable — never block the whole run).
  let tierQuotes: Awaited<ReturnType<typeof chainAdapter.quoteFeeTiers>> | null = null;
  try {
    tierQuotes = await chainAdapter.quoteFeeTiers({
      chainId: parsed.chainId as ChainId,
      fromAddress: parsed.targetAddress as never,
      toAddress: parsed.targetAddress as never,
      token: parsed.token as never,
      amountRaw: "1" as never
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNativeConsolidation) {
      throw new ConsolidationError(
        "INVALID_CHAIN",
        `Could not quote gas for native consolidation on chain ${parsed.chainId}: ${message}`
      );
    }
    deps.logger.warn("pool-consolidation.fee_quote_failed", {
      chainId: parsed.chainId,
      token: parsed.token,
      error: message
    });
  }

  const safety = chainAdapter.gasSafetyFactor(parsed.chainId as ChainId);
  // Per-sweep gas at the broadcast tier with the same safety multiplier the
  // planner applies. null only when the quote failed (token path).
  const perSweepGasRaw = tierQuotes !== null
    ? (BigInt(tierQuotes[internalTier].nativeAmountRaw) * safety.num) / safety.den
    : null;

  // Native consolidation can't drain the source — EVM/Tron sources must retain
  // enough native to pay for the broadcast tx itself. `sweepable = balance -
  // (gasNeeded × 2 race-buffer) - minNativeReserve`. The 2× absorbs gas drift
  // between this quote and planPayout's independent re-quote.
  let nativeSweepBuffer = 0n;
  if (isNativeConsolidation && perSweepGasRaw !== null) {
    const minReserve = chainAdapter.minimumNativeReserve(parsed.chainId as ChainId);
    nativeSweepBuffer = perSweepGasRaw * 2n + minReserve;
  }

  // Fee-aware dynamic dust floor (Lever 2), in the token's smallest unit: skip
  // a source whose token value is worth less than K × the per-sweep gas cost,
  // so every sweep nets positive. For EVM/Tron TOKEN sweeps the sweep is TWO
  // txs (native top-up + ERC-20 transfer), so double the single-tx gas. The
  // floor degrades to 0 (→ static floor) when the quote or oracle is missing.
  //
  // OFF by default (multiplier 0) so it never silently strands balances; the
  // operator opts in via CONSOLIDATION_DUST_GAS_MULTIPLIER (recommended 3–5 for
  // the lowest-fees objective).
  const dustMultiplier = deps.consolidationDustGasMultiplier ?? 0;
  let dynamicFloor = 0n;
  if (dustMultiplier > 0 && perSweepGasRaw !== null) {
    const needsTopUp = !isNativeConsolidation
      && chainAdapter.feeWalletCapability(parsed.chainId as ChainId) !== "co-sign";
    const totalGasNativeRaw = needsTopUp ? perSweepGasRaw * 2n : perSweepGasRaw;
    const nativeSymbol = chainAdapter.nativeSymbol(parsed.chainId as ChainId);
    const nativeDecimals =
      findToken(parsed.chainId, nativeSymbol)?.decimals ??
      (chainAdapter.family === "tron" ? 6 : 18);
    dynamicFloor = await nativeGasToTokenFloor(deps, {
      nativeSymbol,
      nativeRaw: totalGasNativeRaw,
      nativeDecimals,
      token: parsed.token,
      tokenDecimals: tokenInfo.decimals,
      multiplier: dustMultiplier
    });
  }

  // Effective floor: the stricter of the operator's static floor and the
  // gas-aware dynamic floor.
  const minSourceBalance = dynamicFloor > staticFloor ? dynamicFloor : staticFloor;

  // Sources held some of the token but fell below the effective floor — worth
  // surfacing so the operator sees why a balance stayed put (vs. silently
  // dropping empty addresses). Merged into the returned `skipped` list below.
  const dustSkipped: ConsolidationSkip[] = [];

  const sources: { address: string; amountRaw: bigint }[] = [];
  for (const row of allPoolRows) {
    if (row.address === parsed.targetAddress) continue;
    const balance = await computeSpendable(deps, {
      chainId: parsed.chainId,
      address: row.address,
      token: parsed.token
    });
    // For native: deduct the per-source gas + reserve buffer so the amount we
    // hand to planPayout is actually sweepable. For token consolidation the
    // source's gas comes from a separate sponsor / fee wallet, so the full
    // balance is sweepable.
    const sweepable = isNativeConsolidation
      ? (balance > nativeSweepBuffer ? balance - nativeSweepBuffer : 0n)
      : balance;
    if (sweepable >= minSourceBalance) {
      sources.push({ address: row.address, amountRaw: sweepable });
    } else if (sweepable >= staticFloor && balance > 0n) {
      // Excluded specifically by the gas-aware DYNAMIC floor (it cleared the
      // static floor but isn't worth the gas to sweep). Surfaced so the
      // operator sees a balance was deliberately left. Sources below the
      // static floor are dropped silently as before (unchanged behavior).
      dustSkipped.push({
        sourceAddress: row.address,
        amountRaw: sweepable.toString(),
        reason: `BELOW_DYNAMIC_DUST_FLOOR: token value below ${minSourceBalance.toString()} (smallest unit) ≈ ${dustMultiplier}× sweep gas`
      });
    }
  }

  if (sources.length === 0) {
    throw new ConsolidationError(
      "NO_SOURCES_WITH_BALANCE",
      parsed.minSourceBalanceRaw !== undefined && parsed.minSourceBalanceRaw !== "0"
        ? `No pool addresses on chain ${parsed.chainId} hold at least ${parsed.minSourceBalanceRaw} (smallest unit) of ${parsed.token} (other than the target).`
        : `No pool addresses on chain ${parsed.chainId} hold ${parsed.token} (other than the target).`
    );
  }

  // Cap legs-per-call. Auto-consolidation uses this to bound per-tick
  // cost; the manual endpoint omits maxSources and processes everything.
  // Sources are sorted by address (deterministic) before slicing so a
  // re-run picks up exactly where the prior tick left off.
  if (parsed.maxSources !== undefined && sources.length > parsed.maxSources) {
    sources.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    sources.length = parsed.maxSources;
  }

  // Plan each leg. Each call goes through the regular planPayout path with
  // forceSourceAddress pinning the leg to this specific source. Errors
  // are caught per-leg so one unfundable source doesn't block the others
  // — we surface those as `skipped` entries.
  const consolidationId = globalThis.crypto.randomUUID();
  const legs: ConsolidationLeg[] = [];
  // Seed with the gas-aware dust skips collected during discovery so the
  // operator sees both "couldn't plan" and "not worth sweeping" in one list.
  const skipped: ConsolidationSkip[] = [...dustSkipped];

  for (const source of sources) {
    try {
      const result = await planPayout(deps, {
        merchantId: SYSTEM_INTERNAL_MERCHANT_ID,
        chainId: parsed.chainId,
        token: parsed.token,
        amountRaw: source.amountRaw.toString(),
        destinationAddress: parsed.targetAddress,
        batchId: consolidationId,
        forceSourceAddress: source.address,
        internalKind: "consolidation_sweep",
        feeTier: internalTier
      });
      legs.push({
        payoutId: result.id,
        sourceAddress: source.address,
        amountRaw: source.amountRaw.toString()
      });
    } catch (err) {
      const message = formatLegError(err);
      skipped.push({
        sourceAddress: source.address,
        amountRaw: source.amountRaw.toString(),
        reason: message
      });
      deps.logger.warn("pool-consolidation.leg_skipped", {
        consolidationId,
        chainId: parsed.chainId,
        token: parsed.token,
        sourceAddress: source.address,
        reason: message
      });
    }
  }

  return {
    consolidationId,
    chainId: parsed.chainId as ChainId,
    token: parsed.token,
    targetAddress: parsed.targetAddress,
    legs,
    skipped
  };
}

export interface ConsolidationStatus {
  readonly consolidationId: string;
  readonly legs: readonly {
    payoutId: string;
    sourceAddress: string;
    amountRaw: string;
    status: string;
    txHash: string | null;
    topUpTxHash: string | null;
    lastError: string | null;
  }[];
  readonly summary: {
    total: number;
    pendingOrInFlight: number;
    confirmed: number;
    failed: number;
    canceled: number;
  };
}

export async function getConsolidationStatus(
  deps: AppDeps,
  consolidationId: string
): Promise<ConsolidationStatus | null> {
  const rows = await deps.db
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.batchId, consolidationId),
        eq(payouts.kind, "consolidation_sweep")
      )
    );
  if (rows.length === 0) return null;

  const legs = rows.map((r) => ({
    payoutId: r.id,
    sourceAddress: r.sourceAddress ?? "",
    amountRaw: r.amountRaw,
    status: r.status,
    txHash: r.txHash,
    topUpTxHash: r.topUpTxHash,
    lastError: r.lastError
  }));

  const summary = {
    total: legs.length,
    pendingOrInFlight: legs.filter((l) =>
      ["planned", "reserved", "topping-up", "submitted"].includes(l.status)
    ).length,
    confirmed: legs.filter((l) => l.status === "confirmed").length,
    failed: legs.filter((l) => l.status === "failed").length,
    canceled: legs.filter((l) => l.status === "canceled").length
  };

  return { consolidationId, legs, summary };
}
