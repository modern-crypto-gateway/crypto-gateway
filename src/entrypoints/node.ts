import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import "dotenv/config";
import { buildApp } from "../app.js";
import { libsqlAdapter } from "../adapters/db/libsql.adapter.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { processEnvSecrets } from "../adapters/secrets/process-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { staticPegPriceOracle } from "../adapters/price-oracle/static-peg.adapter.js";
import { noopWebhookDispatcher } from "../adapters/webhook-delivery/noop.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
import type { AppDeps } from "../core/app-deps.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";

// Production vs. dev behavior gate. Two things change in production:
//   1. MASTER_SEED is strictly required; the dev fallback is removed.
//   2. The default-merchant seed is skipped — production merchants are created
//      through POST /admin/merchants, never auto-seeded.
// `NODE_ENV` isn't a standard TypeScript convention but it IS the standard
// runtime convention. We treat "production" strictly; anything else (including
// unset) is dev.
function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

async function main(): Promise<void> {
  const production = isProduction();

  // --- Boot-time secret validation -------------------------------------------
  // Do this BEFORE wiring any adapter so a missing secret fails fast with a
  // clear message rather than surfacing later as a viem derivation error.
  if (production) {
    const seed = process.env["MASTER_SEED"];
    if (!seed || seed === "" || seed === "dev-seed") {
      console.error(
        "[boot] MASTER_SEED must be a real BIP39 mnemonic in production. " +
          "Refusing to start with a missing or placeholder seed."
      );
      process.exit(1);
    }
  } else if (process.env["MASTER_SEED"] === undefined) {
    // Dev convenience: accept a deliberately-weak default so `npm run dev:node`
    // works without a .env file. Warn loudly so this is never mistaken for
    // a real configuration.
    process.env["MASTER_SEED"] = "dev-seed";
    console.warn(
      "[boot] WARNING: MASTER_SEED not set. Using the 'dev-seed' placeholder. " +
        "Derivation will fail for real EVM/Tron adapters — set a real BIP39 " +
        "mnemonic in .env before using anything beyond the dev chain adapter."
    );
  }

  const secrets = processEnvSecrets();
  const databaseUrl = secrets.getOptional("DATABASE_URL") ?? "file:./local.db";
  const port = Number(secrets.getOptional("PORT") ?? "8787");

  const dbAuthToken = secrets.getOptional("DATABASE_TOKEN");
  const db = libsqlAdapter(
    dbAuthToken !== undefined ? { url: databaseUrl, authToken: dbAuthToken } : { url: databaseUrl }
  );

  await applySchema(db);
  if (!production) {
    await seedDefaultMerchantIfMissing(db);
  }

  const deps: AppDeps = {
    db,
    cache: memoryCacheAdapter(),
    jobs: promiseSetJobs(),
    secrets: processEnvSecrets(),
    signerStore: memorySignerStore(),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: noopWebhookDispatcher(),
    events: createInMemoryEventBus(),
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
    { fetch: app.fetch as (req: Request) => Response | Promise<Response>, port },
    (info) => {
      console.warn(
        `crypto-gateway (node, ${production ? "production" : "dev"}) listening on http://localhost:${info.port}`
      );
    }
  );

  process.on("SIGTERM", async () => {
    console.warn("SIGTERM received; draining jobs...");
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
async function seedDefaultMerchantIfMissing(db: AppDeps["db"]): Promise<void> {
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
      // leaked to prod (which the NODE_ENV=production guard prevents) nobody
      // could authenticate as this merchant. Real merchants are created via
      // POST /admin/merchants and return their plaintext key once.
      "d1f4b2a4a7e7c6d5c5c3a4e4c3d5e3f3c3e3e3c3d3f3a3e3c3d3e3f3c3e3e3c3",
      now,
      now
    )
    .run();
  console.warn('[seed] dev-only: inserted default merchant "00000000-0000-0000-0000-000000000001"');
}

void main();
