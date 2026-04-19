import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import "dotenv/config";
import { migrate } from "drizzle-orm/libsql/migrator";
import { buildApp } from "../app.js";
import { createDb, createLibsqlClient } from "../db/client.js";
import { devCipher, makeSecretsCipher } from "../adapters/crypto/secrets-cipher.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { httpAlertSink } from "../adapters/logging/http-alert.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { processEnvSecrets } from "../adapters/secrets/process-env.js";
import { hdSignerStore } from "../adapters/signer-store/hd.adapter.js";
import { selectPriceOracle } from "../adapters/price-oracle/select-oracle.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import { dbWebhookDeliveryStore } from "../adapters/webhook-delivery/db-delivery-store.js";
import { evmChainAdapter } from "../adapters/chains/evm/evm-chain.adapter.js";
import { alchemyRpcUrls, parseAlchemyChainsEnv } from "../adapters/chains/evm/alchemy-rpc.js";
import { wireSolana } from "../adapters/chains/solana/wire.js";
import { wireTron } from "../adapters/chains/tron/wire.js";
import { alchemyNotifyDetection } from "../adapters/detection/alchemy-notify.adapter.js";
import { alchemyChainsByFamily } from "../adapters/detection/alchemy-network.js";
import { rpcPollDetection } from "../adapters/detection/rpc-poll.adapter.js";
import { alchemyAdminClient } from "../adapters/detection/alchemy-admin-client.js";
import { dbAlchemyRegistryStore } from "../adapters/detection/alchemy-registry-store.js";
import { readAlchemyNotifyToken } from "../adapters/detection/alchemy-token.js";
import { dbAlchemySubscriptionStore } from "../adapters/detection/alchemy-subscription-store.js";
import { makeAlchemySyncSweep } from "../adapters/detection/alchemy-sync-sweep.js";
import { merchants } from "../db/schema.js";
import { loadConfig, ConfigValidationError } from "../config/config.schema.js";
import type { ChainAdapter } from "../core/ports/chain.port.js";
import type { DetectionStrategy } from "../core/ports/detection.port.js";
import type { AppDeps } from "../core/app-deps.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";
import { parseFinalityOverridesEnv } from "../core/domain/payment-config.js";

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

  const alertSink = config.alertWebhookUrl !== undefined
    ? httpAlertSink({
        url: config.alertWebhookUrl,
        ...(config.alertWebhookAuthHeader !== undefined
          ? { headers: { authorization: config.alertWebhookAuthHeader } }
          : {})
      })
    : undefined;
  const logger = consoleLogger({
    format: production ? "json" : "pretty",
    minLevel: production ? "info" : "debug",
    baseFields: { service: "crypto-gateway", runtime: "node", env: config.environment },
    ...(alertSink !== undefined ? { alertSink } : {})
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
  const libsqlClient = createLibsqlClient(
    dbAuthToken !== undefined ? { url: databaseUrl, authToken: dbAuthToken } : { url: databaseUrl }
  );
  const db = createDb(libsqlClient);

  // Drizzle's migrator tracks applied ids in a `__drizzle_migrations` table,
  // reads the `meta/_journal.json` emitted by drizzle-kit, and applies only
  // migrations the journal marks as new. Idempotent across reboots. On
  // Workers + Vercel Edge there's no filesystem, so migrations are applied
  // CLI-side via `npx drizzle-kit push` (see README).
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle", "migrations");
  await migrate(db, { migrationsFolder });
  logger.info("drizzle migrations applied", { folder: migrationsFolder });
  if (!production) {
    await seedDefaultMerchantIfMissing(db, logger);
  }

  const cache = memoryCacheAdapter();
  // minTtlSeconds: 1 overrides the KV-shaped 60s floor — Node's memory cache
  // has no TTL floor of its own, so sub-minute windows work correctly here.
  const rateLimiter = cacheBackedRateLimiter(cache, { minTtlSeconds: 1 });

  // Chain adapters + their matching detection strategies. Real-chain
  // adapters (EVM / Tron / Solana) are gated on their respective provider
  // creds further down. The synthetic dev adapter is intentionally NOT
  // wired here — it's a test-only fixture loaded by the integration test
  // boot, never shipped to any running server.
  const chains: ChainAdapter[] = [];
  const detectionStrategies: Record<number, DetectionStrategy> = {};
  // Union of chainIds for the pool's Alchemy subscription fan-out (EVM + Solana).
  // Collected as entrypoint wires each family so the pool knows, at refill
  // time, which webhooks to enqueue 'add' rows for.
  const activeAlchemyChainIds: number[] = [];
  if (config.alchemyApiKey !== undefined) {
    const chainIds = parseAlchemyChainsEnv(config.alchemyChains);
    chains.push(
      evmChainAdapter({
        chainIds,
        rpcUrls: alchemyRpcUrls(config.alchemyApiKey, chainIds)
      })
    );
    for (const chainId of chainIds) {
      detectionStrategies[chainId] = rpcPollDetection();
      activeAlchemyChainIds.push(chainId);
    }
    logger.info("Alchemy EVM chains wired", { chainIds });
  }

  // Tron wiring. See wireTron for provider-selection semantics:
  //   - TRONGRID_API_KEY alone: detection + payouts via TronGrid.
  //   - + ALCHEMY_API_KEY: TronGrid primary, Alchemy fallback for /wallet/*.
  //   - ALCHEMY_API_KEY alone: payouts only; detection logs disabled.
  const tronWiringInput: Parameters<typeof wireTron>[0] = {
    network: config.tronNetwork,
    logger
  };
  if (config.trongridApiKey !== undefined) tronWiringInput.trongridApiKey = config.trongridApiKey;
  if (config.alchemyApiKey !== undefined) tronWiringInput.alchemyApiKey = config.alchemyApiKey;
  if (config.tronPollIntervalMs !== undefined) tronWiringInput.pollIntervalMs = config.tronPollIntervalMs;
  const tronWiring = wireTron(tronWiringInput);
  if (tronWiring.chainAdapter && tronWiring.chainId !== undefined) {
    chains.push(tronWiring.chainAdapter);
    if (tronWiring.detectionStrategy) {
      detectionStrategies[tronWiring.chainId] = tronWiring.detectionStrategy;
    }
    logger.info("Tron wired", {
      chainId: tronWiring.chainId,
      detection: tronWiring.detectionStrategy !== undefined
    });
  }

  // Solana wiring. Receive-only for SPL today (native SOL payouts work).
  // RPC URL from SOLANA_RPC_URL, or auto-built from ALCHEMY_API_KEY.
  const solanaWiringInput: Parameters<typeof wireSolana>[0] = {
    network: config.solanaNetwork,
    logger
  };
  if (config.solanaRpcUrl !== undefined) solanaWiringInput.rpcUrl = config.solanaRpcUrl;
  if (config.alchemyApiKey !== undefined) solanaWiringInput.alchemyApiKey = config.alchemyApiKey;
  const solanaWiring = wireSolana(solanaWiringInput);
  if (solanaWiring.chainAdapter && solanaWiring.chainId !== undefined) {
    chains.push(solanaWiring.chainAdapter);
    // Pool's Alchemy fan-out covers Solana too (webhook-based detection).
    activeAlchemyChainIds.push(solanaWiring.chainId);
  }

  // Secrets-at-rest cipher. In prod/staging `SECRETS_ENCRYPTION_KEY` is
  // required (config.schema.ts enforces); in dev/test we fall back to the
  // well-known dev key so `npm run dev:node` works out of the box.
  const secretsCipher = config.secretsEncryptionKey !== undefined
    ? await makeSecretsCipher(config.secretsEncryptionKey)
    : await devCipher();
  if (config.secretsEncryptionKey === undefined) {
    logger.warn(
      "SECRETS_ENCRYPTION_KEY not set; using dev cipher (NOT safe for production). Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`"
    );
  }

  // Alchemy subscription lifecycle: if ALCHEMY_NOTIFY_TOKEN is set (or the
  // deprecated ALCHEMY_AUTH_TOKEN), wire a sync sweep that batches pending
  // add/remove ops from the event-driven subscription queue and posts them
  // to Alchemy's /update-webhook-addresses endpoint.
  let alchemy: AppDeps["alchemy"];
  const alchemyNotifyToken = readAlchemyNotifyToken(secrets, logger);
  if (alchemyNotifyToken !== undefined) {
    const admin = alchemyAdminClient({ authToken: alchemyNotifyToken });
    const sweep = makeAlchemySyncSweep({
      adminClient: admin,
      registryStore: dbAlchemyRegistryStore(db),
      subscriptionStore: dbAlchemySubscriptionStore(db),
      logger
    });
    alchemy = { syncAddresses: sweep };
  }

  const deps: AppDeps = {
    db,
    cache,
    jobs: promiseSetJobs({
      onError: (err, name) => logger.error("deferred job failed", { name, error: String(err) })
    }),
    secrets,
    secretsCipher,
    signerStore: hdSignerStore({ masterSeed: config.masterSeed ?? "dev-seed", chains }),
    priceOracle: selectPriceOracle({
      ...(config.priceAdapter !== undefined ? { priceAdapter: config.priceAdapter } : {}),
      ...(config.coingeckoApiKey !== undefined ? { coingeckoApiKey: config.coingeckoApiKey } : {}),
      coingeckoPlan: config.coingeckoPlan,
      ...(config.coincapApiKey !== undefined ? { coincapApiKey: config.coincapApiKey } : {}),
      ...(config.alchemyApiKey !== undefined ? { alchemyApiKey: config.alchemyApiKey } : {}),
      ...(config.disableCoingecko !== undefined ? { disableCoingecko: config.disableCoingecko } : {}),
      ...(config.disableCoincap !== undefined ? { disableCoincap: config.disableCoincap } : {}),
      ...(config.disableBinance !== undefined ? { disableBinance: config.disableBinance } : {}),
      ...(config.disableAlchemy !== undefined ? { disableAlchemy: config.disableAlchemy } : {}),
      cache,
      logger
    }),
    webhookDispatcher: inlineFetchDispatcher({
      allowHttp: config.environment === "development" || config.environment === "test"
    }),
    webhookDeliveryStore: dbWebhookDeliveryStore(db),
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits: {
      merchantPerMinute: config.rateLimitMerchantPerMinute,
      checkoutPerMinute: config.rateLimitCheckoutPerMinute,
      webhookIngestPerMinute: config.rateLimitWebhookIngestPerMinute,
      adminPerMinute: config.rateLimitAdminPerMinute,
      trustedIpHeaders: config.trustedIpHeaders
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    },
    chains,
    detectionStrategies,
    // Push-based detection. The Alchemy Notify adapter is wired unconditionally
    // — it's inert without incoming webhook POSTs, and this way operators only
    // have to run the admin bootstrap (or manual signing-key register) to
    // enable /webhooks/alchemy end-to-end without touching this file.
    pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
    clock: { now: () => new Date() },
    ...(alchemy !== undefined ? { alchemy } : {}),
    alchemySubscribableChainsByFamily: alchemyChainsByFamily(activeAlchemyChainIds),
    migrationsFolder,
    confirmationThresholds: parseFinalityOverridesEnv(secrets.getOptional("FINALITY_OVERRIDES"))
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

// Dev-only helper. Guarded at the call site by `if (!production)`; this
// function itself remains single-purpose so the dev-only behavior is obvious.
async function seedDefaultMerchantIfMissing(
  db: AppDeps["db"],
  logger: AppDeps["logger"]
): Promise<void> {
  const [existing] = await db.select({ id: merchants.id }).from(merchants).limit(1);
  if (existing) return;
  const now = Date.now();
  await db.insert(merchants).values({
    id: "00000000-0000-0000-0000-000000000001",
    name: "Dev Merchant",
    // Placeholder api_key_hash — no known plaintext preimage. Even if this row
    // leaked to prod (which the environment guard prevents) nobody could
    // authenticate as this merchant. Real merchants are created via
    // POST /admin/merchants and return their plaintext key once.
    apiKeyHash: "d1f4b2a4a7e7c6d5c5c3a4e4c3d5e3f3c3e3e3c3d3f3a3e3c3d3e3f3c3e3e3c3",
    webhookUrl: null,
    webhookSecretCiphertext: null,
    active: 1,
    createdAt: now,
    updatedAt: now
  });
  logger.warn("dev-only: seeded default merchant", { id: "00000000-0000-0000-0000-000000000001" });
}

void main();
