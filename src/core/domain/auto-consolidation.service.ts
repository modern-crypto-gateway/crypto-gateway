import { z } from "zod";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { ChainIdSchema } from "../types/chain.js";
import { AmountRawSchema } from "../types/money.js";
import { TokenSymbolSchema } from "../types/token.js";
import { addressPool, autoConsolidationSchedules, payouts } from "../../db/schema.js";
import { findChainAdapter } from "./chain-lookup.js";
import { findToken } from "../types/token-registry.js";
import {
  ConsolidationError,
  planPoolConsolidation
} from "./pool-consolidation.service.js";
import { isUniqueViolation } from "./db-errors.js";

// Auto-consolidation: admin configures `(chainId, token) → targetAddress`
// once with an interval (every N hours), and the cron defragments matching
// pool addresses on schedule using the existing planPoolConsolidation
// machinery. The per-source dust gate (`minSourceBalanceRaw`) keeps the
// cron from burning gas on dust addresses where the per-tx cost would
// exceed the value being recovered.
//
// Operationally identical to /admin/pool/consolidate — same internal
// `consolidation_sweep` payouts, same executor + confirmer, same status
// shape. The only difference is who triggered it (cron vs admin POST).

// ---- Errors ----

export class AutoConsolidationError extends Error {
  readonly code:
    | "INVALID_CHAIN"
    | "INVALID_TOKEN"
    | "TARGET_NOT_IN_POOL"
    | "SCHEDULE_ALREADY_EXISTS"
    | "SCHEDULE_NOT_FOUND";
  constructor(code: AutoConsolidationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const HTTP_STATUS_BY_CODE: Readonly<Record<AutoConsolidationError["code"], number>> = {
  INVALID_CHAIN: 400,
  INVALID_TOKEN: 400,
  TARGET_NOT_IN_POOL: 400,
  SCHEDULE_ALREADY_EXISTS: 409,
  SCHEDULE_NOT_FOUND: 404
};

export function autoConsolidationErrorStatus(
  code: AutoConsolidationError["code"]
): number {
  return HTTP_STATUS_BY_CODE[code];
}

// ---- CRUD: input shapes ----

export const CreateScheduleInputSchema = z
  .object({
    chainId: ChainIdSchema,
    token: TokenSymbolSchema,
    targetAddress: z.string().min(1).max(128),
    intervalHours: z.number().int().positive().max(720),
    minSourceBalanceRaw: AmountRawSchema,
    maxSourcesPerRun: z.number().int().positive().max(200).default(25),
    enabled: z.boolean().default(true)
  })
  .strict();
export type CreateScheduleInput = z.infer<typeof CreateScheduleInputSchema>;

export const UpdateScheduleInputSchema = z
  .object({
    targetAddress: z.string().min(1).max(128).optional(),
    intervalHours: z.number().int().positive().max(720).optional(),
    minSourceBalanceRaw: AmountRawSchema.optional(),
    maxSourcesPerRun: z.number().int().positive().max(200).optional(),
    enabled: z.boolean().optional()
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided to update"
  });
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInputSchema>;

export const ListSchedulesQuerySchema = z
  .object({
    chainId: z.coerce.number().int().positive().optional(),
    token: z.string().min(1).max(32).optional(),
    enabled: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional()
  })
  .strict();
export type ListSchedulesQuery = z.infer<typeof ListSchedulesQuerySchema>;

// ---- Output shapes ----

export interface ScheduleRow {
  readonly id: string;
  readonly chainId: number;
  readonly token: string;
  readonly targetAddress: string;
  readonly intervalHours: number;
  readonly minSourceBalanceRaw: string;
  readonly maxSourcesPerRun: number;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly lastConsolidationId: string | null;
  readonly lastLegCount: number | null;
  readonly lastSkippedCount: number | null;
  readonly nextRunDue: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function toScheduleRow(row: typeof autoConsolidationSchedules.$inferSelect): ScheduleRow {
  return {
    id: row.id,
    chainId: row.chainId,
    token: row.token,
    targetAddress: row.targetAddress,
    intervalHours: row.intervalHours,
    minSourceBalanceRaw: row.minSourceBalanceRaw,
    maxSourcesPerRun: row.maxSourcesPerRun,
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt,
    lastConsolidationId: row.lastConsolidationId,
    lastLegCount: row.lastLegCount,
    lastSkippedCount: row.lastSkippedCount,
    nextRunDue: row.nextRunDue,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

// ---- CRUD ----

export async function createSchedule(
  deps: AppDeps,
  input: unknown
): Promise<ScheduleRow> {
  const parsed = CreateScheduleInputSchema.parse(input);

  // Validate chain + token before any writes — fail loud if the operator
  // typo'd a chainId or asked for a token that's not registered on that chain.
  let chainAdapter;
  try {
    chainAdapter = findChainAdapter(deps, parsed.chainId);
  } catch {
    throw new AutoConsolidationError(
      "INVALID_CHAIN",
      `No chain adapter wired for chainId ${parsed.chainId}.`
    );
  }
  if (!findToken(parsed.chainId, parsed.token)) {
    throw new AutoConsolidationError(
      "INVALID_TOKEN",
      `Token ${parsed.token} is not registered on chain ${parsed.chainId}.`
    );
  }

  // Verify the target address is actually addressable by the gateway.
  // Same check the manual /admin/pool/consolidate does — consolidation
  // to an address we can't sign for would lock the funds.
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
    throw new AutoConsolidationError(
      "TARGET_NOT_IN_POOL",
      `Target address ${parsed.targetAddress} is not in the ${family} address pool.`
    );
  }

  const now = deps.clock.now().getTime();
  const id = globalThis.crypto.randomUUID();
  const intervalMs = parsed.intervalHours * 3600_000;

  try {
    const [inserted] = await deps.db
      .insert(autoConsolidationSchedules)
      .values({
        id,
        chainId: parsed.chainId,
        token: parsed.token,
        targetAddress: parsed.targetAddress,
        intervalHours: parsed.intervalHours,
        minSourceBalanceRaw: parsed.minSourceBalanceRaw,
        maxSourcesPerRun: parsed.maxSourcesPerRun,
        enabled: parsed.enabled ? 1 : 0,
        lastRunAt: null,
        lastConsolidationId: null,
        lastLegCount: null,
        lastSkippedCount: null,
        // First fire: now + interval. Operator can manually trigger via
        // the existing /admin/pool/consolidate endpoint if they want to
        // sweep right after creating the schedule.
        nextRunDue: now + intervalMs,
        createdAt: now,
        updatedAt: now
      })
      .returning();
    if (!inserted) {
      throw new Error("auto-consolidation insert returned no row");
    }
    return toScheduleRow(inserted);
  } catch (err) {
    // UNIQUE constraint on (chain_id, token) — a schedule already exists
    // for this pair. Surface as 409 rather than a 500. Drizzle wraps the
    // libsql error so we walk the cause chain via isUniqueViolation
    // (same helper payment.service.ts uses for transactions UNIQUE).
    if (isUniqueViolation(err)) {
      throw new AutoConsolidationError(
        "SCHEDULE_ALREADY_EXISTS",
        `A consolidation schedule already exists for chain ${parsed.chainId} / token ${parsed.token}. PATCH the existing one.`
      );
    }
    throw err;
  }
}

export async function listSchedules(
  deps: AppDeps,
  query: unknown
): Promise<readonly ScheduleRow[]> {
  const parsed = ListSchedulesQuerySchema.parse(query);
  const conds = [];
  if (parsed.chainId !== undefined) {
    conds.push(eq(autoConsolidationSchedules.chainId, parsed.chainId));
  }
  if (parsed.token !== undefined) {
    conds.push(eq(autoConsolidationSchedules.token, parsed.token));
  }
  if (parsed.enabled !== undefined) {
    conds.push(eq(autoConsolidationSchedules.enabled, parsed.enabled ? 1 : 0));
  }
  const baseQuery = deps.db
    .select()
    .from(autoConsolidationSchedules)
    .orderBy(desc(autoConsolidationSchedules.createdAt));
  const rows = conds.length > 0
    ? await baseQuery.where(and(...conds))
    : await baseQuery;
  return rows.map(toScheduleRow);
}

export async function getSchedule(
  deps: AppDeps,
  id: string
): Promise<ScheduleRow | null> {
  const [row] = await deps.db
    .select()
    .from(autoConsolidationSchedules)
    .where(eq(autoConsolidationSchedules.id, id))
    .limit(1);
  return row ? toScheduleRow(row) : null;
}

export async function updateSchedule(
  deps: AppDeps,
  id: string,
  input: unknown
): Promise<ScheduleRow> {
  const parsed = UpdateScheduleInputSchema.parse(input);

  const [existing] = await deps.db
    .select()
    .from(autoConsolidationSchedules)
    .where(eq(autoConsolidationSchedules.id, id))
    .limit(1);
  if (!existing) {
    throw new AutoConsolidationError(
      "SCHEDULE_NOT_FOUND",
      `No consolidation schedule with id ${id}.`
    );
  }

  // If targetAddress is changing, validate it's still in the pool.
  if (parsed.targetAddress !== undefined && parsed.targetAddress !== existing.targetAddress) {
    const adapter = findChainAdapter(deps, existing.chainId);
    const [targetRow] = await deps.db
      .select({ address: addressPool.address })
      .from(addressPool)
      .where(
        and(
          eq(addressPool.family, adapter.family),
          eq(addressPool.address, parsed.targetAddress)
        )
      )
      .limit(1);
    if (!targetRow) {
      throw new AutoConsolidationError(
        "TARGET_NOT_IN_POOL",
        `Target address ${parsed.targetAddress} is not in the ${adapter.family} address pool.`
      );
    }
  }

  const now = deps.clock.now().getTime();
  // If interval changes, recompute nextRunDue from the existing baseline
  // (lastRunAt or createdAt). Operators bumping interval down see the
  // schedule fire sooner; bumping it up defers the next fire — both
  // intuitive vs. arbitrarily resetting to "now + new_interval".
  const updates: Partial<typeof autoConsolidationSchedules.$inferInsert> = {
    updatedAt: now
  };
  if (parsed.targetAddress !== undefined) updates.targetAddress = parsed.targetAddress;
  if (parsed.minSourceBalanceRaw !== undefined) {
    updates.minSourceBalanceRaw = parsed.minSourceBalanceRaw;
  }
  if (parsed.maxSourcesPerRun !== undefined) {
    updates.maxSourcesPerRun = parsed.maxSourcesPerRun;
  }
  if (parsed.enabled !== undefined) updates.enabled = parsed.enabled ? 1 : 0;
  if (parsed.intervalHours !== undefined) {
    updates.intervalHours = parsed.intervalHours;
    const baseline = existing.lastRunAt ?? existing.createdAt;
    updates.nextRunDue = baseline + parsed.intervalHours * 3600_000;
  }

  const [updated] = await deps.db
    .update(autoConsolidationSchedules)
    .set(updates)
    .where(eq(autoConsolidationSchedules.id, id))
    .returning();
  if (!updated) {
    throw new AutoConsolidationError(
      "SCHEDULE_NOT_FOUND",
      `Schedule ${id} disappeared between read and write (concurrent delete?).`
    );
  }
  return toScheduleRow(updated);
}

export async function deleteSchedule(
  deps: AppDeps,
  id: string
): Promise<{ deleted: boolean }> {
  const result = await deps.db
    .delete(autoConsolidationSchedules)
    .where(eq(autoConsolidationSchedules.id, id))
    .returning({ id: autoConsolidationSchedules.id });
  if (result.length === 0) {
    throw new AutoConsolidationError(
      "SCHEDULE_NOT_FOUND",
      `No consolidation schedule with id ${id}.`
    );
  }
  return { deleted: true };
}

// ---- Cron entry point ----

export interface RunAutoConsolidationsResult {
  readonly checked: number;
  readonly fired: number;
  readonly skipped: number;
  readonly errors: number;
}

export async function runAutoConsolidations(
  deps: AppDeps
): Promise<RunAutoConsolidationsResult> {
  const now = deps.clock.now().getTime();

  // Atomic claim: advance nextRunDue on every due+enabled schedule and
  // get back the rows we now own for this tick. A concurrent tick
  // running the same query sees the new nextRunDue (already in the
  // future) and the WHERE clause excludes the row — natural mutex.
  // We bump nextRunDue by intervalHours*3600000 ms.
  const claimed = await deps.db
    .update(autoConsolidationSchedules)
    .set({
      lastRunAt: now,
      nextRunDue: sql`${autoConsolidationSchedules.nextRunDue} + ${autoConsolidationSchedules.intervalHours} * 3600000`,
      updatedAt: now
    })
    .where(
      and(
        eq(autoConsolidationSchedules.enabled, 1),
        lte(autoConsolidationSchedules.nextRunDue, now)
      )
    )
    .returning();

  let fired = 0;
  let skipped = 0;
  let errors = 0;

  for (const sched of claimed) {
    // In-flight detection. If the prior run's legs are still pending
    // (reserved / topping-up / submitted), don't pile new ones on top —
    // skip this tick. The atomic UPDATE above already advanced
    // nextRunDue, so we'll naturally try again next interval.
    const inflight = await deps.db
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(
          eq(payouts.kind, "consolidation_sweep"),
          eq(payouts.chainId, sched.chainId),
          eq(payouts.token, sched.token),
          inArray(payouts.status, ["planned", "reserved", "topping-up", "submitted"])
        )
      )
      .limit(1);
    if (inflight.length > 0) {
      skipped += 1;
      deps.logger.info("auto_consolidation.skipped_inflight", {
        scheduleId: sched.id,
        chainId: sched.chainId,
        token: sched.token,
        existingPayoutId: inflight[0]!.id
      });
      continue;
    }

    try {
      const result = await planPoolConsolidation(deps, {
        chainId: sched.chainId,
        token: sched.token,
        targetAddress: sched.targetAddress,
        minSourceBalanceRaw: sched.minSourceBalanceRaw,
        maxSources: sched.maxSourcesPerRun
      });

      // Snapshot last-run summary on the schedule so the GET endpoint
      // can show "last fired N legs at T" without joining payouts.
      await deps.db
        .update(autoConsolidationSchedules)
        .set({
          lastConsolidationId: result.consolidationId,
          lastLegCount: result.legs.length,
          lastSkippedCount: result.skipped.length,
          updatedAt: deps.clock.now().getTime()
        })
        .where(eq(autoConsolidationSchedules.id, sched.id));

      fired += 1;
      deps.logger.info("auto_consolidation.fired", {
        scheduleId: sched.id,
        chainId: sched.chainId,
        token: sched.token,
        consolidationId: result.consolidationId,
        legCount: result.legs.length,
        skippedCount: result.skipped.length
      });
    } catch (err) {
      errors += 1;
      // NO_SOURCES_WITH_BALANCE is the normal "nothing to do" case at
      // quiet times — log at INFO. Other ConsolidationErrors (target
      // gone, chain misconfigured) and unknown errors at WARN.
      const code = err instanceof ConsolidationError ? err.code : "UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);
      const log = code === "NO_SOURCES_WITH_BALANCE"
        ? deps.logger.info.bind(deps.logger)
        : deps.logger.warn.bind(deps.logger);
      log("auto_consolidation.run_failed", {
        scheduleId: sched.id,
        chainId: sched.chainId,
        token: sched.token,
        code,
        message
      });
    }
  }

  return { checked: claimed.length, fired, skipped, errors };
}
