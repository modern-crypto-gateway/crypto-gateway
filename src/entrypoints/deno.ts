import { buildApp } from "../app.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
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
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb, createLibsqlClient } from "../db/client.js";
import { devCipher, makeSecretsCipher } from "../adapters/crypto/secrets-cipher.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { httpAlertSink } from "../adapters/logging/http-alert.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { selectPriceOracle } from "../adapters/price-oracle/select-oracle.js";
import { denoEnvSecrets } from "../adapters/secrets/deno-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import { dbWebhookDeliveryStore } from "../adapters/webhook-delivery/db-delivery-store.js";
import type { AppDeps } from "../core/app-deps.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";
import { runScheduledJobs } from "../core/domain/scheduled-jobs.js";
import { parseFinalityOverridesEnv } from "../core/domain/payment-config.js";

// Local Deno type declaration. We avoid adding a global shim (which would
// pollute every other file's type scope) and instead declare just the Deno
// surface this file uses. ESLint's narrow override allows the `Deno` global
// in this specific file.
declare const Deno: {
  serve(
    options: { port?: number; hostname?: string; onListen?: (addr: { port: number; hostname: string }) => void },
    handler: (req: Request) => Response | Promise<Response>
  ): { finished: Promise<void>; shutdown(): Promise<void> };
  cron(name: string, schedule: string, handler: () => void | Promise<void>): Promise<void>;
  env: { get(name: string): string | undefined; toObject(): Record<string, string> };
  exit(code: number): never;
};

async function main(): Promise<void> {
  const secrets = denoEnvSecrets();
  // TURSO_URL is the canonical post-Turso-pivot name; DATABASE_URL remains an
  // alias for one release cycle so existing local .env files keep working.
  const databaseUrl =
    secrets.getOptional("TURSO_URL") ?? secrets.getOptional("DATABASE_URL") ?? "file:./local.db";
  const port = Number(secrets.getOptional("PORT") ?? "8787");
  const dbAuthToken =
    secrets.getOptional("TURSO_AUTH_TOKEN") ?? secrets.getOptional("DATABASE_TOKEN");

  const libsqlClient = createLibsqlClient(
    dbAuthToken !== undefined ? { url: databaseUrl, authToken: dbAuthToken } : { url: databaseUrl }
  );
  const db = createDb(libsqlClient);

  const alertWebhookUrl = secrets.getOptional("ALERT_WEBHOOK_URL");
  const alertAuthHeader = secrets.getOptional("ALERT_WEBHOOK_AUTH_HEADER");
  const alertSink = alertWebhookUrl !== undefined
    ? httpAlertSink({
        url: alertWebhookUrl,
        ...(alertAuthHeader !== undefined ? { headers: { authorization: alertAuthHeader } } : {})
      })
    : undefined;
  const logger = consoleLogger({
    format: "json",
    minLevel: "info",
    baseFields: { service: "crypto-gateway", runtime: "deno" },
    ...(alertSink !== undefined ? { alertSink } : {})
  });

  // Apply Drizzle migrations at boot. Deno supports Drizzle's libsql migrator
  // because it has filesystem access + node:fs/node:path compat. The migrator
  // is idempotent: it reads `meta/_journal.json` and applies only new entries.
  const migrationsFolderUrl = new URL("../../drizzle/migrations/", import.meta.url);
  // `URL.pathname` on Windows (`file:///C:/...`) returns `/C:/...` with a
  // leading slash; libsql migrator's fs.readdir rejects that shape. Strip
  // only when `import.meta.url` is a file: URL and the path looks Windows-y.
  const pathname = migrationsFolderUrl.pathname;
  const migrationsFolder = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  await migrate(db, { migrationsFolder });
  logger.info("drizzle migrations applied", { folder: migrationsFolder });

  const cache = memoryCacheAdapter();
  const rateLimiter = cacheBackedRateLimiter(cache, { minTtlSeconds: 1 });

  const chains = [devChainAdapter()];
  const detectionStrategies: Record<number, ReturnType<typeof rpcPollDetection>> = {};
  const activeAlchemyChainIds: number[] = [];
  const alchemyApiKey = secrets.getOptional("ALCHEMY_API_KEY");
  if (alchemyApiKey !== undefined) {
    const chainIds = parseAlchemyChainsEnv(secrets.getOptional("ALCHEMY_CHAINS"));
    chains.push(
      evmChainAdapter({ chainIds, rpcUrls: alchemyRpcUrls(alchemyApiKey, chainIds) })
    );
    for (const chainId of chainIds) {
      detectionStrategies[chainId] = rpcPollDetection();
      activeAlchemyChainIds.push(chainId);
    }
    logger.info("Alchemy EVM chains wired", { chainIds });
  }

  // Tron wiring.
  const trongridApiKey = secrets.getOptional("TRONGRID_API_KEY");
  const tronNetwork = secrets.getOptional("TRON_NETWORK") === "nile" ? "nile" : "mainnet";
  const tronPollIntervalMsRaw = secrets.getOptional("TRON_POLL_INTERVAL_MS");
  const tronPollIntervalMs = tronPollIntervalMsRaw !== undefined ? Number.parseInt(tronPollIntervalMsRaw, 10) : undefined;
  const tronWiringInput: Parameters<typeof wireTron>[0] = {
    network: tronNetwork,
    logger
  };
  if (trongridApiKey !== undefined) tronWiringInput.trongridApiKey = trongridApiKey;
  if (alchemyApiKey !== undefined) tronWiringInput.alchemyApiKey = alchemyApiKey;
  if (tronPollIntervalMs !== undefined && Number.isFinite(tronPollIntervalMs)) {
    tronWiringInput.pollIntervalMs = tronPollIntervalMs;
  }
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

  // Solana wiring.
  const solanaRpcUrl = secrets.getOptional("SOLANA_RPC_URL");
  const solanaNetwork = secrets.getOptional("SOLANA_NETWORK") === "devnet" ? "devnet" : "mainnet";
  const solanaWiringInput: Parameters<typeof wireSolana>[0] = {
    network: solanaNetwork,
    logger
  };
  if (solanaRpcUrl !== undefined) solanaWiringInput.rpcUrl = solanaRpcUrl;
  if (alchemyApiKey !== undefined) solanaWiringInput.alchemyApiKey = alchemyApiKey;
  const solanaWiring = wireSolana(solanaWiringInput);
  if (solanaWiring.chainAdapter && solanaWiring.chainId !== undefined) {
    chains.push(solanaWiring.chainAdapter);
    activeAlchemyChainIds.push(solanaWiring.chainId);
  }

  // SECRETS_ENCRYPTION_KEY is REQUIRED in production / staging.
  const secretsEncryptionKey = secrets.getOptional("SECRETS_ENCRYPTION_KEY");
  const nodeEnv = secrets.getOptional("NODE_ENV");
  const isProdLike = nodeEnv === "production" || nodeEnv === "staging";
  if (isProdLike && secretsEncryptionKey === undefined) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is required when NODE_ENV=production or staging. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  const secretsCipher = secretsEncryptionKey !== undefined
    ? await makeSecretsCipher(secretsEncryptionKey)
    : await devCipher();
  if (secretsEncryptionKey === undefined) {
    logger.warn("SECRETS_ENCRYPTION_KEY not set; using dev cipher (NOT safe for production)");
  }

  let alchemy: AppDeps["alchemy"];
  const alchemyNotifyToken = readAlchemyNotifyToken(secrets, logger);
  if (alchemyNotifyToken !== undefined) {
    const sweep = makeAlchemySyncSweep({
      adminClient: alchemyAdminClient({ authToken: alchemyNotifyToken }),
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
    signerStore: memorySignerStore({
      runtime: "deno",
      ...(secrets.getOptional("NODE_ENV") !== undefined ? { environment: secrets.getOptional("NODE_ENV")! } : {}),
      logger
    }),
    priceOracle: selectPriceOracle({
      ...(secrets.getOptional("PRICE_ADAPTER") === "coingecko" ||
      secrets.getOptional("PRICE_ADAPTER") === "static-peg" ||
      secrets.getOptional("PRICE_ADAPTER") === "alchemy"
        ? { priceAdapter: secrets.getOptional("PRICE_ADAPTER") as "coingecko" | "static-peg" | "alchemy" }
        : {}),
      ...(secrets.getOptional("COINGECKO_API_KEY") !== undefined
        ? { coingeckoApiKey: secrets.getOptional("COINGECKO_API_KEY")! }
        : {}),
      coingeckoPlan: secrets.getOptional("COINGECKO_PLAN") === "pro" ? "pro" : "demo",
      ...(secrets.getOptional("COINCAP_API_KEY") !== undefined
        ? { coincapApiKey: secrets.getOptional("COINCAP_API_KEY")! }
        : {}),
      ...(alchemyApiKey !== undefined ? { alchemyApiKey } : {}),
      ...(secrets.getOptional("DISABLE_COINGECKO") === "1" ? { disableCoingecko: true } : {}),
      ...(secrets.getOptional("DISABLE_COINCAP") === "1" ? { disableCoincap: true } : {}),
      ...(secrets.getOptional("DISABLE_BINANCE") === "1" ? { disableBinance: true } : {}),
      ...(secrets.getOptional("DISABLE_ALCHEMY") === "1" ? { disableAlchemy: true } : {}),
      cache,
      logger
    }),
    webhookDispatcher: inlineFetchDispatcher({
      allowHttp:
        secrets.getOptional("NODE_ENV") === "development" ||
        secrets.getOptional("NODE_ENV") === "test"
    }),
    webhookDeliveryStore: dbWebhookDeliveryStore(db),
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits: {
      merchantPerMinute: Number(secrets.getOptional("RATE_LIMIT_MERCHANT_PER_MINUTE") ?? "1000"),
      checkoutPerMinute: Number(secrets.getOptional("RATE_LIMIT_CHECKOUT_PER_MINUTE") ?? "60"),
      webhookIngestPerMinute: Number(secrets.getOptional("RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE") ?? "300"),
      adminPerMinute: Number(secrets.getOptional("RATE_LIMIT_ADMIN_PER_MINUTE") ?? "30"),
      trustedIpHeaders: (secrets.getOptional("TRUSTED_IP_HEADERS") ?? "x-forwarded-for")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    },
    chains,
    detectionStrategies,
    pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
    clock: { now: () => new Date() },
    ...(alchemy !== undefined ? { alchemy } : {}),
    alchemySubscribableChainsByFamily: alchemyChainsByFamily(activeAlchemyChainIds),
    migrationsFolder,
    confirmationThresholds: parseFinalityOverridesEnv(secrets.getOptional("FINALITY_OVERRIDES"))
  };

  const app = buildApp(deps);

  // Deno.cron is stable (Deno 1.38+) and native on Deno Deploy. Every minute
  // runs the full scheduled-jobs sequence. Named after the cadence so Deno
  // Deploy's observability panels are self-explanatory. `void` because the
  // registration promise resolves once the cron is queued with the runtime;
  // subsequent tick failures surface via the handler's own error path, not
  // this call's return value.
  void Deno.cron("scheduled-jobs-1m", "* * * * *", async () => {
    await runScheduledJobs(deps);
  });

  Deno.serve(
    {
      port,
      onListen: ({ hostname, port: listeningPort }) => {
        // `.error` is permitted by our ESLint rule; `.log` would warn.
        console.error(`crypto-gateway (deno) listening on http://${hostname}:${listeningPort}`);
      }
    },
    async (req) => app.fetch(req)
  );
}

main().catch((err) => {
  console.error("crypto-gateway (deno) failed to start:", err);
  Deno.exit(1);
});
