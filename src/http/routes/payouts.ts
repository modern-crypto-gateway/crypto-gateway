import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import {
  cancelPayout,
  estimatePayoutFees,
  getPayout,
  listPayouts,
  planPayout,
  planPayoutBatch
} from "../../core/domain/payout.service.js";
import { PayoutIdSchema, PayoutStatusSchema, type Payout, type PayoutId } from "../../core/types/payout.js";
import { renderError } from "../middleware/error-handler.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { apiKeyAuth, type AuthedVariables } from "../middleware/api-key-auth.js";

// Merchant-facing payout routes. POST plans a payout; execution + confirmation
// happen in cron jobs (executeReservedPayouts + confirmPayouts). The POST
// returns immediately with status='planned' — merchants discover terminal
// status via webhook or by polling GET /:id.

export function payoutsRouter(deps: AppDeps): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();

  app.use("*", apiKeyAuth(deps));
  app.use(
    "*",
    rateLimit(deps, {
      // See invoices.ts — separate scope per surface so invoices traffic
      // doesn't drain a merchant's payouts quota.
      scope: "merchant-api:payouts",
      keyFn: (c) => (c.get("merchantId") as string | undefined) ?? null,
      limit: deps.rateLimits.merchantPerMinute,
      windowSeconds: 60
    })
  );

  // Paginated list, newest first. AND-combined filters; no filter surfaces
  // the whole merchant's payout history sorted createdAt DESC.
  app.get("/", async (c) => {
    try {
      const statusParam = c.req.query("status");
      const status =
        statusParam === undefined || statusParam === ""
          ? undefined
          : statusParam
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
      if (status !== undefined) {
        for (const s of status) {
          if (!PayoutStatusSchema.safeParse(s).success) {
            return c.json(
              { error: { code: "BAD_STATUS", message: `Unknown status: ${s}` } },
              400
            );
          }
        }
      }

      const chainIdRaw = c.req.query("chainId");
      const chainId = chainIdRaw === undefined ? undefined : Number(chainIdRaw);
      if (chainIdRaw !== undefined && !Number.isFinite(chainId)) {
        return c.json({ error: { code: "BAD_CHAIN_ID", message: "chainId must be a number" } }, 400);
      }

      const createdFrom = parseTimestampQuery(c.req.query("createdFrom"));
      const createdTo = parseTimestampQuery(c.req.query("createdTo"));
      if (createdFrom === "invalid" || createdTo === "invalid") {
        return c.json(
          { error: { code: "BAD_TIMESTAMP", message: "createdFrom / createdTo must be ISO-8601 or unix-ms" } },
          400
        );
      }

      const result = await listPayouts(deps, {
        merchantId: c.get("merchantId"),
        status,
        chainId,
        token: c.req.query("token"),
        destinationAddress: c.req.query("destinationAddress"),
        sourceAddress: c.req.query("sourceAddress"),
        batchId: c.req.query("batchId"),
        createdFrom,
        createdTo,
        limit: c.req.query("limit") !== undefined ? Number(c.req.query("limit")) : undefined,
        offset: c.req.query("offset") !== undefined ? Number(c.req.query("offset")) : undefined
      });
      return c.json({
        payouts: result.payouts.map(serializePayout),
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore
      });
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON", message: "Request body must be JSON" } }, 400);
    }
    try {
      const input = { ...body, merchantId: c.get("merchantId") };
      const payout = await planPayout(deps, input);
      return c.json({ payout: serializePayout(payout) }, 201);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Mass-create up to 100 payouts in one call. Per-row validation; partial
  // success is the norm (HTTP 200 when ANY row succeeds, 400 only when the
  // batch itself is malformed). Every successfully-planned row shares a
  // single `batchId` returned on the response, which the merchant can use
  // to list them together via `GET /api/v1/payouts?batchId=<id>`.
  app.post("/batch", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON", message: "Request body must be JSON" } }, 400);
    }
    const rows = Array.isArray((body as { payouts?: unknown }).payouts)
      ? ((body as { payouts: unknown[] }).payouts)
      : null;
    if (rows === null) {
      return c.json(
        { error: { code: "BAD_JSON", message: "Request body must be { payouts: [...] }" } },
        400
      );
    }
    try {
      const merchantId = c.get("merchantId") as string;

      // Proportional rate limit: a batch of N rows costs N tokens against
      // the merchant's per-minute budget. The surrounding `rateLimit`
      // middleware already consumed 1 token (for THIS request); we consume
      // `N - 1` more before doing the heavy work. Prevents a merchant from
      // bursting 100×`merchantPerMinute` payout creates via 1 token of cost.
      const extraTokens = Math.max(0, rows.length - 1);
      for (let i = 0; i < extraTokens; i += 1) {
        const r = await deps.rateLimiter.consume({
          key: `merchant-api:payouts:${merchantId}`,
          limit: deps.rateLimits.merchantPerMinute,
          windowSeconds: 60
        });
        if (!r.allowed) {
          const retryAfter = Math.max(1, Math.ceil((r.resetMs - Date.now()) / 1000));
          c.header("retry-after", String(retryAfter));
          return c.json(
            {
              error: {
                code: "RATE_LIMITED",
                message: `Batch size ${rows.length} exceeds remaining quota. Retry after ${retryAfter}s or split into smaller batches.`
              }
            },
            429
          );
        }
      }

      const result = await planPayoutBatch(deps, merchantId, rows);
      // Serialize every planned payout the same way the single-create
      // endpoint does so the client's payload handler is uniform.
      const serialized = {
        batchId: result.batchId,
        results: result.results.map((r) =>
          r.status === "planned"
            ? { index: r.index, status: "planned" as const, payout: serializePayout(r.payout) }
            : r
        ),
        summary: result.summary
      };
      return c.json(serialized, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Quote three fee tiers for a hypothetical payout WITHOUT planning anything
  // or reserving a wallet. The merchant uses this to show the operator low /
  // medium / high cost options before they commit to a tier on the actual
  // POST. Re-estimation at broadcast time picks up baseFee drift, so a small
  // delta between quoted and actual is expected (especially on EVM under
  // congestion).
  app.post("/estimate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON", message: "Request body must be JSON" } }, 400);
    }
    try {
      const input = { ...body, merchantId: c.get("merchantId") };
      const result = await estimatePayoutFees(deps, input);
      return c.json(result, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  app.get("/:id", async (c) => {
    const id = parsePayoutIdParam(c.req.param("id"));
    if (id === null) {
      // Malformed ids get the same 404 as missing ids so an attacker can't
      // enumerate by shape.
      return c.json({ error: { code: "NOT_FOUND" } }, 404);
    }
    const payout = await getPayout(deps, id);
    // 404 on cross-merchant access: don't leak which ids exist.
    if (!payout || payout.merchantId !== c.get("merchantId")) {
      return c.json({ error: { code: "NOT_FOUND", message: `Payout ${id} not found` } }, 404);
    }
    return c.json({ payout: serializePayout(payout) });
  });

  // Cancel a `reserved` payout. Releases the reservation rows so the
  // source's spendable balance frees up immediately. Idempotent on
  // already-canceled rows; rejects with 409 PAYOUT_NOT_CANCELABLE once
  // the payout has broadcast (topping-up / submitted) — chain owns the
  // funds at that point.
  app.post("/:id/cancel", async (c) => {
    const id = parsePayoutIdParam(c.req.param("id"));
    if (id === null) {
      return c.json({ error: { code: "NOT_FOUND" } }, 404);
    }
    try {
      const payout = await cancelPayout(deps, {
        merchantId: c.get("merchantId"),
        payoutId: id
      });
      return c.json({ payout: serializePayout(payout) });
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  return app;
}

// ISO-8601 or unix-ms numeric string; returns the "invalid" sentinel on
// malformed input so the caller can 400 distinctly from "absent". See
// invoices.ts for the same helper / rationale.
function parseTimestampQuery(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : "invalid";
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

function parsePayoutIdParam(raw: string | undefined): PayoutId | null {
  if (raw === undefined) return null;
  const parsed = PayoutIdSchema.safeParse(raw);
  return parsed.success ? (parsed.data as PayoutId) : null;
}

function serializePayout(payout: Payout): Record<string, unknown> {
  return {
    ...payout,
    createdAt: payout.createdAt.toISOString(),
    submittedAt: payout.submittedAt === null ? null : payout.submittedAt.toISOString(),
    confirmedAt: payout.confirmedAt === null ? null : payout.confirmedAt.toISOString(),
    updatedAt: payout.updatedAt.toISOString()
  };
}

