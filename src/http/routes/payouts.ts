import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { getPayout, planPayout } from "../../core/domain/payout.service.js";
import { PayoutIdSchema, type Payout, type PayoutId } from "../../core/types/payout.js";
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

