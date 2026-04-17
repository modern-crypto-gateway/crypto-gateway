import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { getOrder } from "../../core/domain/order.service.js";
import type { OrderId } from "../../core/types/order.js";
import { getClientIp, rateLimit } from "../middleware/rate-limit.js";

// Public checkout view. Anyone with an order id can fetch the details needed
// to render a "send N TOKEN to ADDRESS" page / QR code. The order id itself is
// a UUID — high entropy, unguessable. No merchant API key required here.
//
// Surface is deliberately narrower than the merchant API:
//   - merchant identifier is NOT exposed
//   - internal timestamps (updatedAt) omitted
//   - metadata field omitted (may contain merchant-private data)

export function checkoutRouter(deps: AppDeps): Hono {
  const app = new Hono();

  // Per-IP limit on the public checkout surface. Abusive scanning of many
  // order ids from one IP trips this; normal merchants serve their end users
  // from distinct IPs.
  app.use(
    "*",
    rateLimit(deps, {
      scope: "checkout",
      keyFn: (c) => getClientIp(c),
      limit: deps.rateLimits.checkoutPerMinute,
      windowSeconds: 60
    })
  );

  app.get("/:id", async (c) => {
    const id = c.req.param("id") as OrderId;
    const order = await getOrder(deps, id);
    if (!order) {
      return c.json({ error: { code: "NOT_FOUND", message: `Order ${id} not found` } }, 404);
    }
    return c.json({
      order: {
        id: order.id,
        status: order.status,
        chainId: order.chainId,
        token: order.token,
        receiveAddress: order.receiveAddress,
        // Multi-family: one address per accepted family. The checkout UI
        // renders all of them so the payer can choose which chain to pay on.
        // Single-family orders have exactly one entry; UI can fall back to
        // `receiveAddress` + `chainId` for simple cases.
        acceptedFamilies: order.acceptedFamilies,
        receiveAddresses: order.receiveAddresses.map((r) => ({
          family: r.family,
          address: r.address
        })),
        requiredAmountRaw: order.requiredAmountRaw,
        receivedAmountRaw: order.receivedAmountRaw,
        fiatAmount: order.fiatAmount,
        fiatCurrency: order.fiatCurrency,
        createdAt: order.createdAt.toISOString(),
        expiresAt: order.expiresAt.toISOString(),
        confirmedAt: order.confirmedAt === null ? null : order.confirmedAt.toISOString()
      }
    });
  });

  return app;
}
