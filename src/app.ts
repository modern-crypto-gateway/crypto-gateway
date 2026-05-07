import { Hono } from "hono";
import type { AppDeps } from "./core/app-deps.js";
import { confirmTransactions } from "./core/domain/payment.service.js";
import { confirmPayouts, executeReservedPayouts, reconcileFailedPayoutGasBurns } from "./core/domain/payout.service.js";
import { pollPayments } from "./core/domain/poll-payments.js";
import { registerPoolReleaseHandler } from "./core/domain/pool.service.js";
import { registerWebhookSubscriber } from "./core/domain/webhook-subscriber.js";
import { dbAlchemySubscriptionStore } from "./adapters/detection/alchemy-subscription-store.js";
import { registerAlchemySubscriptionTracker } from "./adapters/detection/alchemy-subscription-tracker.js";
import { registerBlockcypherSubscriptionTracker } from "./adapters/detection/blockcypher-subscription-tracker.js";
import { dbBlockcypherSubscriptionStore } from "./adapters/detection/blockcypher-subscription-store.js";
import { renderError } from "./http/middleware/error-handler.js";
import { requestIdMiddleware, type RequestIdVariables } from "./http/middleware/request-id.js";
import { securityHeaders } from "./http/middleware/security-headers.js";
import { adminRouter } from "./http/routes/admin.js";
import { checkoutRouter } from "./http/routes/checkout.js";
import { internalCronRouter } from "./http/routes/internal-cron.js";
import { invoicesRouter } from "./http/routes/invoices.js";
import { payoutsRouter } from "./http/routes/payouts.js";
import { webhooksIngestRouter } from "./http/routes/webhooks-ingest.js";

// Runtime-agnostic application factory. Each entrypoint constructs AppDeps
// using concrete adapters for its runtime, then calls buildApp(deps) and wires
// the returned `fetch` / `jobs` to the host.

export interface App {
  fetch: (request: Request) => Response | Promise<Response>;
  jobs: Readonly<Record<string, () => Promise<void>>>;
}

// Wires every domain-event subscriber on `deps.events`. MUST be called for
// any AppDeps that will publish events — including cron-only entrypoints
// that bypass `buildApp` (Workers `scheduled` handler). Without this the
// in-memory bus has zero listeners and every published webhook event is
// silently dropped on the floor.
export function registerEventSubscribers(deps: AppDeps): void {
  registerWebhookSubscriber(deps);
  // Pool release: every invoice.completed/expired/canceled returns its pool
  // row(s) to 'available' so the address can serve the next invoice. This is
  // the whole point of the reuse model — one pool row, N invoices, 1 sweep.
  registerPoolReleaseHandler(deps);
  // Alchemy subscription tracker is registered only when the deployment has
  // Alchemy configured (deps.alchemy present). It listens for pool.address
  // events and enqueues per-chain subscription rows; chains not in the
  // deployment's active set get skipped.
  if (deps.alchemy !== undefined) {
    registerAlchemySubscriptionTracker({
      events: deps.events,
      store: dbAlchemySubscriptionStore(deps.db),
      logger: deps.logger,
      clock: deps.clock,
      alchemyChainsByFamily: deps.alchemySubscribableChainsByFamily ?? {}
    });
  }
  // BlockCypher subscription tracker — translates UTXO invoice lifecycle
  // events into per-address subscribe/unsubscribe rows for the
  // `blockcypher_subscriptions` queue. Registered only when the deployment
  // has BlockCypher configured for at least one UTXO chain
  // (BLOCKCYPHER_TOKEN_<SLUG> + BLOCKCYPHER_CALLBACK_URL_<SLUG> for that
  // chain), surfaced via `deps.blockcypher.configuredChainIds`. Events for
  // chains NOT in `configuredChainIds` are dropped at enqueue time. Esplora
  // poll keeps detecting even without BlockCypher; this is purely a
  // sub-30s push accelerator.
  if (deps.blockcypher !== undefined) {
    registerBlockcypherSubscriptionTracker({
      events: deps.events,
      store: dbBlockcypherSubscriptionStore(deps.db),
      logger: deps.logger,
      clock: deps.clock,
      configuredChainIds: deps.blockcypher.configuredChainIds
    });
  }
}

export function buildApp(deps: AppDeps): App {
  const app = new Hono<{ Variables: RequestIdVariables }>();

  // Wire event-bus subscribers. Subscriptions stay active for the lifetime of
  // this buildApp call — one set per AppDeps is the contract.
  registerEventSubscribers(deps);

  // Security headers sit above everything else so error responses and 404s
  // get them too. Header-only — adds no per-request work beyond Map writes.
  app.use("*", securityHeaders());

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

  app.route("/api/v1/invoices", invoicesRouter(deps));
  app.route("/api/v1/payouts", payoutsRouter(deps));
  app.route("/admin", adminRouter(deps));
  app.route("/checkout", checkoutRouter(deps));
  app.route("/webhooks", webhooksIngestRouter(deps));
  app.route("/internal/cron", internalCronRouter(deps));

  return {
    fetch: (request: Request) => app.fetch(request),
    jobs: {
      // Payment poller — enumerates active invoices, delegates per-chain to
      // the configured DetectionStrategy, ingests detected transfers.
      // Irrelevant on push-only deployments (Alchemy Notify) where
      // detectionStrategies is empty.
      pollPayments: async () => {
        await pollPayments(deps);
      },
      // Confirmation sweeper — checks each 'detected' tx against the chain's
      // current confirmation count, promotes to 'confirmed' past threshold,
      // and recomputes invoice status for any invoice whose txs changed.
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
      },
      // Gas-burn reconciliation — retries `gas_burn` synthesis for any
      // failed-and-broadcast payout whose receipt wasn't yet visible to
      // the RPC at fail-time. Without this, a transient RPC lag at the
      // moment of failure permanently loses the gas-burn debit from the
      // ledger, leaving `computeSpendable` thinking the source still has
      // its pre-failure native balance, the next plan picks it as direct
      // (no top-up), and the EVM adapter's pre-broadcast safety check
      // fires "insufficient native balance for broadcast". The cron
      // self-heals: each tick re-attempts every failed-with-txHash row
      // that has no gas_burn child yet.
      reconcileFailedPayoutGasBurns: async () => {
        await reconcileFailedPayoutGasBurns(deps);
      }
    }
  };
}
