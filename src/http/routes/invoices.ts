import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import {
  createInvoice,
  expireInvoice,
  getInvoice,
  getInvoiceDetails,
  listInvoices,
  type InvoiceDetails
} from "../../core/domain/invoice.service.js";
import { InvoiceIdSchema, InvoiceStatusSchema, type Invoice, type InvoiceId } from "../../core/types/invoice.js";
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
      // Per-surface scope: invoices and payouts each get their own
      // per-merchant bucket. Previously both surfaces shared
      // `merchant-api:<id>`, so a burst of /invoices calls could starve the
      // merchant's /payouts quota (and vice-versa). Separate scopes keep
      // each surface independently limited at `merchantPerMinute`.
      scope: "merchant-api:invoices",
      keyFn: (c) => (c.get("merchantId") as string | undefined) ?? null,
      limit: deps.rateLimits.merchantPerMinute,
      windowSeconds: 60
    })
  );

  // Paginated list, newest first. All filters are optional and AND-combined.
  // Ownership is implicit — merchantId is injected from the auth context and
  // never read from the query string, so there's no way to list another
  // merchant's invoices by construction.
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
      // Reject unknown status values with 400 rather than silently dropping them
      // — quietly ignoring typos would make a misspelled status produce a
      // merchant's entire backlog and look like a working filter.
      if (status !== undefined) {
        for (const s of status) {
          if (!InvoiceStatusSchema.safeParse(s).success) {
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

      const result = await listInvoices(deps, {
        merchantId: c.get("merchantId"),
        status,
        chainId,
        token: c.req.query("token"),
        externalId: c.req.query("externalId"),
        toAddress: c.req.query("toAddress"),
        fromAddress: c.req.query("fromAddress"),
        createdFrom,
        createdTo,
        limit: c.req.query("limit") !== undefined ? Number(c.req.query("limit")) : undefined,
        offset: c.req.query("offset") !== undefined ? Number(c.req.query("offset")) : undefined
      });
      return c.json({
        invoices: result.invoices.map(serializeInvoice),
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
      // Inject merchantId server-side; ignore whatever the caller sent.
      const input = { ...body, merchantId: c.get("merchantId") };
      const invoice = await createInvoice(deps, input);
      return c.json({ invoice: serializeInvoice(invoice) }, 201);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  app.get("/:id", async (c) => {
    const id = parseInvoiceIdParam(c.req.param("id"));
    if (id === null) {
      // Unknown id shape -> 404, same as "doesn't exist", so an attacker can't
      // distinguish malformed vs missing ids and enumerate the keyspace.
      return c.json({ error: { code: "NOT_FOUND" } }, 404);
    }
    const details = await getInvoiceDetails(deps, id);
    if (!details || details.invoice.merchantId !== c.get("merchantId")) {
      return c.json({ error: { code: "NOT_FOUND", message: `Invoice ${id} not found` } }, 404);
    }
    return c.json(serializeInvoiceDetails(details));
  });

  app.post("/:id/expire", async (c) => {
    const id = parseInvoiceIdParam(c.req.param("id"));
    if (id === null) {
      return c.json({ error: { code: "NOT_FOUND" } }, 404);
    }
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

// Accepts either an ISO-8601 string or a unix-ms numeric string. Returns
// undefined for missing input, the parsed number on success, or the literal
// "invalid" sentinel on a malformed value — the caller 400s on sentinel.
// Done inline rather than through Zod because the sentinel propagates the
// distinction between "absent" and "malformed" with less ceremony than two
// separate Zod pipelines.
function parseTimestampQuery(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  // Pure numeric string -> unix ms.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : "invalid";
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

// Validate that the path-param id is a UUID before it ever touches the DB.
// Stops malformed inputs from wasting a SELECT round-trip and forces every id
// that reaches `getInvoice` to be shape-correct.
function parseInvoiceIdParam(raw: string | undefined): InvoiceId | null {
  if (raw === undefined) return null;
  const parsed = InvoiceIdSchema.safeParse(raw);
  return parsed.success ? (parsed.data as InvoiceId) : null;
}

// Dates serialize as ISO strings. No other transforms — the `Invoice` shape is
// already JSON-friendly because all on-chain amounts are decimal strings.
function serializeInvoice(invoice: Invoice): Record<string, unknown> {
  return {
    ...invoice,
    createdAt: invoice.createdAt.toISOString(),
    expiresAt: invoice.expiresAt.toISOString(),
    confirmedAt: invoice.confirmedAt === null ? null : invoice.confirmedAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
    rateWindowExpiresAt:
      invoice.rateWindowExpiresAt === null ? null : invoice.rateWindowExpiresAt.toISOString()
  };
}

// Wraps the invoice serializer with the USD breakdown + per-tx detail. Used
// only by GET /:id — POST and POST /expire return the bare invoice (no
// transactions yet, so the breakdown would be empty/zero noise).
function serializeInvoiceDetails(details: InvoiceDetails): Record<string, unknown> {
  return {
    invoice: serializeInvoice(details.invoice),
    amounts: details.amounts,
    transactions: details.transactions
  };
}
