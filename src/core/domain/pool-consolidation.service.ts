import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { ChainIdSchema, type ChainId } from "../types/chain.js";
import { TokenSymbolSchema } from "../types/token.js";
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
    targetAddress: z.string().min(1).max(128)
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

  const sources: { address: string; amountRaw: bigint }[] = [];
  for (const row of allPoolRows) {
    if (row.address === parsed.targetAddress) continue;
    const balance = await computeSpendable(deps, {
      chainId: parsed.chainId,
      address: row.address,
      token: parsed.token
    });
    if (balance > 0n) {
      sources.push({ address: row.address, amountRaw: balance });
    }
  }

  if (sources.length === 0) {
    throw new ConsolidationError(
      "NO_SOURCES_WITH_BALANCE",
      `No pool addresses on chain ${parsed.chainId} hold ${parsed.token} (other than the target).`
    );
  }

  // Plan each leg. Each call goes through the regular planPayout path with
  // forceSourceAddress pinning the leg to this specific source. Errors
  // are caught per-leg so one unfundable source doesn't block the others
  // — we surface those as `skipped` entries.
  const consolidationId = globalThis.crypto.randomUUID();
  const legs: ConsolidationLeg[] = [];
  const skipped: ConsolidationSkip[] = [];

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
        internalKind: "consolidation_sweep"
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
