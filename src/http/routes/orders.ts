import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../core/app-deps.js";
import { createOrder, expireOrder, getOrder, OrderError } from "../../core/domain/order.service.js";
import type { Order, OrderId } from "../../core/types/order.js";
import { apiKeyAuth, type AuthedVariables } from "../middleware/api-key-auth.js";

// Merchant-facing order routes. All endpoints require API-key authentication;
// the authenticated merchantId is injected into the body server-side so a
// merchant cannot create orders for another merchant even if they try.
//
// Ownership enforcement: GET/POST expire return 404 for orders belonging to
// a different merchant. We deliberately use 404 (not 403) so merchants can't
// enumerate whether another merchant's order id exists.

export function ordersRouter(deps: AppDeps): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();

  app.use("*", apiKeyAuth(deps));

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON", message: "Request body must be JSON" } }, 400);
    }
    try {
      // Inject merchantId server-side; ignore whatever the caller sent.
      const input = { ...body, merchantId: c.get("merchantId") };
      const order = await createOrder(deps, input);
      return c.json({ order: serializeOrder(order) }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id") as OrderId;
    const order = await getOrder(deps, id);
    if (!order || order.merchantId !== c.get("merchantId")) {
      return c.json({ error: { code: "NOT_FOUND", message: `Order ${id} not found` } }, 404);
    }
    return c.json({ order: serializeOrder(order) });
  });

  app.post("/:id/expire", async (c) => {
    const id = c.req.param("id") as OrderId;
    const existing = await getOrder(deps, id);
    if (!existing || existing.merchantId !== c.get("merchantId")) {
      return c.json({ error: { code: "NOT_FOUND", message: `Order ${id} not found` } }, 404);
    }
    try {
      const order = await expireOrder(deps, id);
      return c.json({ order: serializeOrder(order) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}

// Dates serialize as ISO strings. No other transforms — the `Order` shape is
// already JSON-friendly because all on-chain amounts are decimal strings.
function serializeOrder(order: Order): Record<string, unknown> {
  return {
    ...order,
    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
    confirmedAt: order.confirmedAt === null ? null : order.confirmedAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}

function handleError(c: Context, err: unknown): Response {
  if (err instanceof ZodError) {
    return c.json({ error: { code: "VALIDATION", message: "Invalid request", details: err.issues } }, 400);
  }
  if (err instanceof OrderError) {
    const status =
      err.code === "MERCHANT_NOT_FOUND"
        ? 404
        : err.code === "TOKEN_NOT_SUPPORTED"
          ? 400
          : err.code === "MERCHANT_INACTIVE"
            ? 403
            : err.code === "EXPIRE_NOT_ALLOWED"
              ? 409
              : 500;
    return c.json({ error: { code: err.code, message: err.message } }, status);
  }
  console.error("[orders] unhandled error:", err);
  return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
}
