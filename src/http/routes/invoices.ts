import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { createInvoice, expireInvoice, getInvoice } from "../../core/domain/invoice.service.js";
import type { Invoice, InvoiceId } from "../../core/types/invoice.js";
import { renderError } from "../middleware/error-handler.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { apiKeyAuth, type AuthedVariables } from "../middleware/api-key-auth.js";

// Merchant-facing invoice routes. All endpoints require API-key authentication;
// the authenticated merchantId is injected into the body server-side so a
// merchant cannot create invoices for another merchant even if they try.
//
// Ownership enforcement: GET/POST expire return 404 for invoices belonging to
// a different merchant. We deliberately use 404 (not 403) so merchants can't
// enumerate whether another merchant's invoice id exists.

export function invoicesRouter(deps: AppDeps): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();

  app.use("*", apiKeyAuth(deps));
  // Rate-limit per authenticated merchant. keyFn reads merchantId from the
  // auth-middleware context; it can't return null here because auth above
  // would have already rejected with 401.
  app.use(
    "*",
    rateLimit(deps, {
      scope: "merchant-api",
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
      // Inject merchantId server-side; ignore whatever the caller sent.
      const input = { ...body, merchantId: c.get("merchantId") };
      const invoice = await createInvoice(deps, input);
      return c.json({ invoice: serializeInvoice(invoice) }, 201);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id") as InvoiceId;
    const invoice = await getInvoice(deps, id);
    if (!invoice || invoice.merchantId !== c.get("merchantId")) {
      return c.json({ error: { code: "NOT_FOUND", message: `Invoice ${id} not found` } }, 404);
    }
    return c.json({ invoice: serializeInvoice(invoice) });
  });

  app.post("/:id/expire", async (c) => {
    const id = c.req.param("id") as InvoiceId;
    const existing = await getInvoice(deps, id);
    if (!existing || existing.merchantId !== c.get("merchantId")) {
      return c.json({ error: { code: "NOT_FOUND", message: `Invoice ${id} not found` } }, 404);
    }
    try {
      const invoice = await expireInvoice(deps, id);
      return c.json({ invoice: serializeInvoice(invoice) });
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  return app;
}

// Dates serialize as ISO strings. No other transforms — the `Invoice` shape is
// already JSON-friendly because all on-chain amounts are decimal strings.
function serializeInvoice(invoice: Invoice): Record<string, unknown> {
  return {
    ...invoice,
    createdAt: invoice.createdAt.toISOString(),
    expiresAt: invoice.expiresAt.toISOString(),
    confirmedAt: invoice.confirmedAt === null ? null : invoice.confirmedAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString()
  };
}
