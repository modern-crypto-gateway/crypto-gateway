import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { getPayout, listPayouts, planPayout } from "../../core/domain/payout.service.js";
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

