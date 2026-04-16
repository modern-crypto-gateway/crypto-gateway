import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../core/app-deps.js";
import { getPayout, planPayout, PayoutError } from "../../core/domain/payout.service.js";
import type { Payout, PayoutId } from "../../core/types/payout.js";
import { apiKeyAuth, type AuthedVariables } from "../middleware/api-key-auth.js";

// Merchant-facing payout routes. POST plans a payout; execution + confirmation
// happen in cron jobs (executeReservedPayouts + confirmPayouts). The POST
// returns immediately with status='planned' — merchants discover terminal
// status via webhook or by polling GET /:id.

export function payoutsRouter(deps: AppDeps): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();

  app.use("*", apiKeyAuth(deps));

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
      return handleError(c, err);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id") as PayoutId;
    const payout = await getPayout(deps, id);
    // 404 on cross-merchant access: don't leak which ids exist.
    if (!payout || payout.merchantId !== c.get("merchantId")) {
      return c.json({ error: { code: "NOT_FOUND", message: `Payout ${id} not found` } }, 404);
    }
    return c.json({ payout: serializePayout(payout) });
  });

  return app;
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

function handleError(c: Context, err: unknown): Response {
  if (err instanceof ZodError) {
    return c.json({ error: { code: "VALIDATION", message: "Invalid request", details: err.issues } }, 400);
  }
  if (err instanceof PayoutError) {
    const status =
      err.code === "MERCHANT_NOT_FOUND"
        ? 404
        : err.code === "TOKEN_NOT_SUPPORTED"
          ? 400
          : err.code === "INVALID_DESTINATION"
            ? 400
            : err.code === "MERCHANT_INACTIVE"
              ? 403
              : 500;
    return c.json({ error: { code: err.code, message: err.message } }, status);
  }
  console.error("[payouts] unhandled error:", err);
  return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
}
