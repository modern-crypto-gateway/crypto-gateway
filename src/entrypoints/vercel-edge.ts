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
import { createDb, createLibsqlClient } from "../db/client.js";
import { devCipher, makeSecretsCipher } from "../adapters/crypto/secrets-cipher.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { httpAlertSink } from "../adapters/logging/http-alert.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { selectPriceOracle } from "../adapters/price-oracle/select-oracle.js";
import { processEnvSecrets } from "../adapters/secrets/process-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import { dbWebhookDeliveryStore } from "../adapters/webhook-delivery/db-delivery-store.js";
import type { AppDeps } from "../core/app-deps.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";
import { parseFinalityOverridesEnv } from "../core/domain/payment-config.js";

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
async function getDeps(): Promise<AppDeps> {
  const existing = cachedDeps;
  if (existing !== null) return existing;
  const secrets = processEnvSecrets();
  // TURSO_URL is the canonical post-Turso-pivot name; DATABASE_URL remains an
  // alias for one release cycle. Edge runtime has no filesystem, so migrations
  // are applied CLI-side via `npx drizzle-kit push` rather than at boot.
  const databaseUrl = secrets.getOptional("TURSO_URL") ?? secrets.getRequired("DATABASE_URL");
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
    baseFields: { service: "crypto-gateway", runtime: "vercel-edge" },
    ...(alertSink !== undefined ? { alertSink } : {})
  });
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

  // SECRETS_ENCRYPTION_KEY is REQUIRED in production / staging. Falling
  // through to devCipher would encrypt every secret with a publicly-known
  // zero key; refuse to boot instead.
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

  const fresh: AppDeps = {
    db,
    cache,
    jobs: promiseSetJobs({
      onError: (err, name) => logger.error("deferred job failed", { name, error: String(err) })
    }),
    secrets,
    secretsCipher,
    signerStore: memorySignerStore({
      runtime: "vercel-edge",
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
      trustedIpHeaders: (secrets.getOptional("TRUSTED_IP_HEADERS") ?? "x-vercel-forwarded-for,x-real-ip")
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
    confirmationThresholds: parseFinalityOverridesEnv(secrets.getOptional("FINALITY_OVERRIDES"))
  };
  cachedDeps = fresh;
  return fresh;
}

// Best-effort boot-error reporter. If getDeps throws (missing
// SECRETS_ENCRYPTION_KEY in prod, bad DATABASE_URL, etc.) we log to
// console.error and fan out a POST to ALERT_WEBHOOK_URL so ops see the
// failure rather than discovering via a 500 from a paying merchant.
async function reportBootFailure(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const payload = {
    ts: new Date().toISOString(),
    level: "fatal",
    msg: "vercel-edge boot failed",
    service: "crypto-gateway",
    runtime: "vercel-edge",
    error: message,
    ...(stack !== undefined ? { stack } : {})
  };
  console.error(JSON.stringify(payload));

  // processEnvSecrets() is a pure wrapper over process.env — safe to call here
  // even though getDeps() just failed. We need env access without pulling in
  // the deps graph whose construction just errored.
  const bootSecrets = processEnvSecrets();
  const alertUrl = bootSecrets.getOptional("ALERT_WEBHOOK_URL");
  if (alertUrl === undefined || alertUrl.length === 0) return;
  const authHeader = bootSecrets.getOptional("ALERT_WEBHOOK_AUTH_HEADER");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(alertUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader !== undefined ? { authorization: authHeader } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch {
    // fire-and-forget — already logged to console.
  } finally {
    clearTimeout(timer);
  }
}

// Vercel Edge invokes the default export with (Request) and expects Response
// (or Promise<Response>). Hono's `.fetch` matches that signature exactly.
export default async function handler(req: Request): Promise<Response> {
  let deps: AppDeps;
  try {
    deps = await getDeps();
  } catch (err) {
    await reportBootFailure(err);
    return new Response(
      JSON.stringify({ error: "service misconfigured", detail: "see server logs" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
  const app = buildApp(deps);
  return app.fetch(req) as Promise<Response>;
}
