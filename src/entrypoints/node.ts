import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import "dotenv/config";
import { buildApp } from "../app.js";
import { libsqlAdapter } from "../adapters/db/libsql.adapter.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { processEnvSecrets } from "../adapters/secrets/process-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { staticPegPriceOracle } from "../adapters/price-oracle/static-peg.adapter.js";
import { noopWebhookDispatcher } from "../adapters/webhook-delivery/noop.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
import { loadConfig, ConfigValidationError } from "../config/config.schema.js";
import type { AppDeps } from "../core/app-deps.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";

async function main(): Promise<void> {
  // Boot-time config validation. loadConfig throws a ConfigValidationError
  // aggregating every missing or malformed field; catching it here lets us
  // exit with a clear message instead of surfacing N individual failures
  // scattered across later lazy lookups.
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(`[boot] ${err.message}`);
    } else {
      console.error("[boot] unexpected config error:", err);
    }
    process.exit(1);
  }
  const production = config.environment === "production";

  const logger = consoleLogger({
    format: production ? "json" : "pretty",
    minLevel: production ? "info" : "debug",
    baseFields: { service: "crypto-gateway", runtime: "node", env: config.environment }
  });

  // Dev convenience: if no MASTER_SEED was set and the config allowed it
  // (loadConfig's refinement only enforces it in production), fall back to a
  // deliberately-weak placeholder and warn. Derivation for real EVM/Tron/Solana
  // adapters will fail with viem's own error until a real mnemonic is set.
  if (!production && config.masterSeed === undefined) {
    process.env["MASTER_SEED"] = "dev-seed";
    logger.warn(
      "MASTER_SEED not set; using 'dev-seed' placeholder. Real EVM/Tron/Solana derivation will fail until a real BIP39 mnemonic is set."
    );
  }

  const secrets = processEnvSecrets();
  const databaseUrl = config.databaseUrl ?? "file:./local.db";
  const dbAuthToken = config.databaseToken;
  const db = libsqlAdapter(
    dbAuthToken !== undefined ? { url: databaseUrl, authToken: dbAuthToken } : { url: databaseUrl }
  );

  await applySchema(db);
  if (!production) {
    await seedDefaultMerchantIfMissing(db, logger);
  }

  const cache = memoryCacheAdapter();
  // minTtlSeconds: 1 overrides the KV-shaped 60s floor — Node's memory cache
  // has no TTL floor of its own, so sub-minute windows work correctly here.
  const rateLimiter = cacheBackedRateLimiter(cache, { minTtlSeconds: 1 });

  const deps: AppDeps = {
    db,
    cache,
    jobs: promiseSetJobs({
      onError: (err, name) => logger.error("deferred job failed", { name, error: String(err) })
    }),
    secrets,
    signerStore: memorySignerStore(),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: noopWebhookDispatcher(),
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits: {
      merchantPerMinute: config.rateLimitMerchantPerMinute,
      checkoutPerMinute: config.rateLimitCheckoutPerMinute,
      webhookIngestPerMinute: config.rateLimitWebhookIngestPerMinute
    },
    chains: [devChainAdapter()],
    // Push-only for local dev by default: no detection strategies wired. Uncomment
    // and add an RPC poll strategy per chain when pointing the dev server at real
    // testnets.
    detectionStrategies: {},
    // No push providers by default. Wire up alchemyNotifyDetection() here and
    // set ALCHEMY_NOTIFY_SIGNING_KEY in env to enable /webhooks/alchemy.
    pushStrategies: {},
    clock: { now: () => new Date() }
  };

  const app = buildApp(deps);

  const server = serve(
    { fetch: app.fetch as (req: Request) => Response | Promise<Response>, port: config.port },
    (info) => {
      logger.info("listening", { port: info.port, url: `http://localhost:${info.port}` });
    }
  );

  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received; draining jobs");
    await deps.jobs.drain(10_000);
    server.close();
    process.exit(0);
  });
}

async function applySchema(db: AppDeps["db"]): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/entrypoints/node.ts  ->  repo root is two dirs up.
  const schemaPath = resolve(here, "..", "..", "migrations", "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  await db.exec(sql);
}

// Dev-only helper. Guarded at the call site by `if (!production)`; this
// function itself remains single-purpose so the dev-only behavior is obvious.
async function seedDefaultMerchantIfMissing(db: AppDeps["db"], logger: AppDeps["logger"]): Promise<void> {
  const existing = await db.prepare("SELECT id FROM merchants LIMIT 1").first<{ id: string }>();
  if (existing) return;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO merchants (id, name, api_key_hash, webhook_url, webhook_secret_hash, active, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, 1, ?, ?)`
    )
    .bind(
      "00000000-0000-0000-0000-000000000001",
      "Dev Merchant",
      // Placeholder api_key_hash — no known plaintext preimage. Even if this row
      // leaked to prod (which the environment guard prevents) nobody could
      // authenticate as this merchant. Real merchants are created via
      // POST /admin/merchants and return their plaintext key once.
      "d1f4b2a4a7e7c6d5c5c3a4e4c3d5e3f3c3e3e3c3d3f3a3e3c3d3e3f3c3e3e3c3",
      now,
      now
    )
    .run();
  logger.warn("dev-only: seeded default merchant", { id: "00000000-0000-0000-0000-000000000001" });
}

void main();
