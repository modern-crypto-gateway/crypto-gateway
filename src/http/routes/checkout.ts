import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { getOrder } from "../../core/domain/order.service.js";
import type { OrderId } from "../../core/types/order.js";

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
