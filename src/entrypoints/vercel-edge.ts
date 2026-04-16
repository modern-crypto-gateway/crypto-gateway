import { buildApp } from "../app.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
import { libsqlAdapter } from "../adapters/db/libsql.adapter.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { staticPegPriceOracle } from "../adapters/price-oracle/static-peg.adapter.js";
import { processEnvSecrets } from "../adapters/secrets/process-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import type { AppDeps } from "../core/app-deps.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";

// Vercel Edge runtime entrypoint. The `runtime` export is how Vercel decides
// this file runs on the Edge runtime (V8-based) rather than Node serverless.
export const runtime = "edge";

// Scheduled jobs on Vercel are HTTP-triggered — Vercel Cron POSTs to
// /internal/cron/tick on a schedule declared in vercel.json, with an
// `Authorization: Bearer $CRON_SECRET` header that the internal-cron route
// verifies. No native cron to wire here.

// The edge runtime re-uses the same shim process.env that Node projects
// expose, so `processEnvSecrets` works unchanged. For libSQL, the http-based
// variant auto-selected by @libsql/client handles the edge runtime's lack of
// net sockets — no code change required vs the Node path.

let cachedDeps: AppDeps | null = null;
function getDeps(): AppDeps {
  const existing = cachedDeps;
  if (existing !== null) return existing;
  const secrets = processEnvSecrets();
  const databaseUrl = secrets.getRequired("DATABASE_URL");
  const dbAuthToken = secrets.getOptional("DATABASE_TOKEN");
  const db = libsqlAdapter(
    dbAuthToken !== undefined ? { url: databaseUrl, authToken: dbAuthToken } : { url: databaseUrl }
  );
  const logger = consoleLogger({
    format: "json",
    minLevel: "info",
    baseFields: { service: "crypto-gateway", runtime: "vercel-edge" }
  });
  const cache = memoryCacheAdapter();
  const rateLimiter = cacheBackedRateLimiter(cache, { minTtlSeconds: 1 });
  const fresh: AppDeps = {
    db,
    cache,
    jobs: promiseSetJobs({
      onError: (err, name) => logger.error("deferred job failed", { name, error: String(err) })
    }),
    secrets,
    signerStore: memorySignerStore(),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: inlineFetchDispatcher(),
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits: {
      merchantPerMinute: Number(secrets.getOptional("RATE_LIMIT_MERCHANT_PER_MINUTE") ?? "1000"),
      checkoutPerMinute: Number(secrets.getOptional("RATE_LIMIT_CHECKOUT_PER_MINUTE") ?? "60"),
      webhookIngestPerMinute: Number(secrets.getOptional("RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE") ?? "300")
    },
    chains: [devChainAdapter()],
    detectionStrategies: {},
    pushStrategies: {},
    clock: { now: () => new Date() }
  };
  cachedDeps = fresh;
  return fresh;
}

// Vercel Edge invokes the default export with (Request) and expects Response
// (or Promise<Response>). Hono's `.fetch` matches that signature exactly.
export default async function handler(req: Request): Promise<Response> {
  const app = buildApp(getDeps());
  return app.fetch(req) as Promise<Response>;
}
