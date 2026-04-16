import { Hono } from "hono";
import type { AppDeps } from "./core/app-deps.js";
import { confirmTransactions } from "./core/domain/payment.service.js";
import { confirmPayouts, executeReservedPayouts } from "./core/domain/payout.service.js";
import { pollPayments } from "./core/domain/poll-payments.js";
import { registerWebhookSubscriber } from "./core/domain/webhook-subscriber.js";
import { renderError } from "./http/middleware/error-handler.js";
import { requestIdMiddleware, type RequestIdVariables } from "./http/middleware/request-id.js";
import { adminRouter } from "./http/routes/admin.js";
import { checkoutRouter } from "./http/routes/checkout.js";
import { internalCronRouter } from "./http/routes/internal-cron.js";
import { ordersRouter } from "./http/routes/orders.js";
import { payoutsRouter } from "./http/routes/payouts.js";
import { webhooksIngestRouter } from "./http/routes/webhooks-ingest.js";

// Runtime-agnostic application factory. Each entrypoint constructs AppDeps
// using concrete adapters for its runtime, then calls buildApp(deps) and wires
// the returned `fetch` / `jobs` to the host.

export interface App {
  fetch: (request: Request) => Response | Promise<Response>;
  jobs: Readonly<Record<string, () => Promise<void>>>;
}

export function buildApp(deps: AppDeps): App {
  const app = new Hono<{ Variables: RequestIdVariables }>();

  // Wire event-bus subscribers. Subscriptions stay active for the lifetime of
  // this buildApp call — one set per AppDeps is the contract.
  registerWebhookSubscriber(deps);

  // Request-id propagation sits at the root so every downstream route sees
  // the id in the context and echoes it in the response header.
  app.use("*", requestIdMiddleware());

  // Global error handler — catches anything that escapes a route's own
  // try/catch (or handlers that just `throw` directly). Pairs the error with
  // the request id so operators can pivot from a log line back to a response.
  app.onError((err, c) => {
    const logger = deps.logger.child({ requestId: c.get("requestId") });
    return renderError(c, err, logger);
  });

  app.get("/health", (c) => c.json({ status: "ok", phase: 8 }));

  app.route("/api/v1/orders", ordersRouter(deps));
  app.route("/api/v1/payouts", payoutsRouter(deps));
  app.route("/admin", adminRouter(deps));
  app.route("/checkout", checkoutRouter(deps));
  app.route("/webhooks", webhooksIngestRouter(deps));
  app.route("/internal/cron", internalCronRouter(deps));

  return {
    fetch: (request: Request) => app.fetch(request),
    jobs: {
      // Payment poller — enumerates active orders, delegates per-chain to the
      // configured DetectionStrategy, ingests detected transfers. Irrelevant
      // on push-only deployments (Alchemy Notify) where detectionStrategies
      // is empty.
      pollPayments: async () => {
        await pollPayments(deps);
      },
      // Confirmation sweeper — checks each 'detected' tx against the chain's
      // current confirmation count, promotes to 'confirmed' past threshold, and
      // recomputes order status for any order whose txs changed.
      confirmTransactions: async () => {
        await confirmTransactions(deps);
      },
      // Payout executor — picks up 'planned' payouts, CAS-reserves a fee
      // wallet, builds/signs/broadcasts. One tick per cron interval.
      executeReservedPayouts: async () => {
        await executeReservedPayouts(deps);
      },
      // Payout confirmation sweeper — moves 'submitted' payouts to
      // confirmed/failed based on the chain's current view.
      confirmPayouts: async () => {
        await confirmPayouts(deps);
      }
    }
  };
}
