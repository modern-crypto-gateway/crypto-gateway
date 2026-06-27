import type { ExecutionContext, KVNamespace, RateLimit, ScheduledController } from "@cloudflare/workers-types";
import { buildApp, registerEventSubscribers } from "../app.js";
import { cfKvAdapter } from "../adapters/cache/cf-kv.adapter.js";
import { evmChainAdapter } from "../adapters/chains/evm/evm-chain.adapter.js";
import {
  bitcoinChainAdapter,
  litecoinChainAdapter
} from "../adapters/chains/utxo/utxo-chain.adapter.js";
import {
  BITCOIN_CONFIG,
  LITECOIN_CONFIG,
  utxoConfigForChainId
} from "../adapters/chains/utxo/utxo-config.js";
import { moneroChainAdapter } from "../adapters/chains/monero/monero-chain.adapter.js";
import {
  MONERO_MAINNET_CONFIG,
  MONERO_STAGENET_CONFIG,
  MONERO_TESTNET_CONFIG,
  type MoneroChainConfig
} from "../adapters/chains/monero/monero-config.js";
import {
  moneroDaemonRpcClient,
  parseMoneroRpcUrlsEnv,
  parseMoneroRpcHeadersEnv
} from "../adapters/chains/monero/monero-rpc.js";
import { loadBlockcypherChainConfigs } from "../adapters/detection/blockcypher-config.js";
import { dbBlockcypherSubscriptionStore } from "../adapters/detection/blockcypher-subscription-store.js";
import { makeBlockcypherSyncSweep } from "../adapters/detection/blockcypher-sync-sweep.js";
import { blockcypherNotifyDetection } from "../adapters/detection/blockcypher-notify.adapter.js";
import { alchemyRpcUrls, parseAlchemyChainsEnv } from "../adapters/chains/evm/alchemy-rpc.js";
import { wireSolana } from "../adapters/chains/solana/wire.js";
import { wireTron } from "../adapters/chains/tron/wire.js";
import { alchemyNotifyDetection } from "../adapters/detection/alchemy-notify.adapter.js";
import { alchemyChainsByFamily } from "../adapters/detection/alchemy-network.js";
import { rpcPollDetection } from "../adapters/detection/rpc-poll.adapter.js";
import { alchemyAdminClient } from "../adapters/detection/alchemy-admin-client.js";
import { dbAlchemyRegistryStore } from "../adapters/detection/alchemy-registry-store.js";
import { readAlchemyNotifyTokenFromEnv } from "../adapters/detection/alchemy-token.js";
import { dbAlchemySubscriptionStore } from "../adapters/detection/alchemy-subscription-store.js";
import { makeAlchemySyncSweep } from "../adapters/detection/alchemy-sync-sweep.js";
import { createDb, createLibsqlClient } from "../db/client.js";
import { devCipher, makeSecretsCipher } from "../adapters/crypto/secrets-cipher.js";
import { waitUntilJobs } from "../adapters/jobs/wait-until.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { httpAlertSink } from "../adapters/logging/http-alert.adapter.js";
import { selectPriceOracle } from "../adapters/price-oracle/select-oracle.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { cloudflareRateLimiter } from "../adapters/rate-limit/cloudflare.adapter.js";
import { workersEnvSecrets } from "../adapters/secrets/workers-env.js";
import { hdSignerStore } from "../adapters/signer-store/hd.adapter.js";
import { dbFeeWalletStore } from "../adapters/fee-wallet-store/db.adapter.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import { dbWebhookDeliveryStore } from "../adapters/webhook-delivery/db-delivery-store.js";
import type { AppDeps } from "../core/app-deps.js";
import type { ChainAdapter } from "../core/ports/chain.port.js";
import { runScheduledJobs } from "../core/domain/scheduled-jobs.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";
import { parseFinalityOverridesEnv } from "../core/domain/payment-config.js";

// Cloudflare Workers entrypoint. Exports { fetch, scheduled } as required by
// the Workers runtime. Each invocation constructs a fresh AppDeps using the
// request-scoped ExecutionContext (waitUntil) and the shared env binding.
//
// buildApp itself is runtime-agnostic — this file is the only Workers-aware
// code on the request path. Keeping it under ~100 lines is the plan's test of
// whether the architecture held up.

export interface WorkerEnv {
  // Bindings declared in wrangler.jsonc
  KV: KVNamespace;
  // Turso (libSQL) connection — REQUIRED. No D1 fallback: D1's dependency on
  // Durable Objects gives 10-15s cold-start tails under low traffic, which
  // is unacceptable for a payment gateway. TURSO_URL points at the libSQL
  // instance (typically `libsql://<db>-<org>.turso.io`) and TURSO_AUTH_TOKEN
  // holds the database's auth token (set via `wrangler secret put`).
  TURSO_URL: string;
  TURSO_AUTH_TOKEN: string;
  // Cloudflare built-in rate-limit bindings. Each (scope, limit, period) is
  // declared in wrangler.jsonc. The adapter falls through to the cache-backed
  // limiter for any scope whose binding is absent, so operators can roll
  // these out one at a time. Scopes match the prefix used by rate-limit.ts
  // (see `rateLimit({ scope: ... })` call sites).
  RATE_LIMIT_ADMIN?: RateLimit;
  RATE_LIMIT_CHECKOUT?: RateLimit;
  RATE_LIMIT_WEBHOOK_INGEST?: RateLimit;
  RATE_LIMIT_MERCHANT_API?: RateLimit;

  // Secrets (set via `wrangler secret put`)
  MASTER_SEED: string;
  ADMIN_KEY?: string;
  ALCHEMY_API_KEY?: string;
  ALCHEMY_CHAINS?: string;

  // String env vars from wrangler.jsonc [vars]
  [key: string]: unknown;
}

async function depsFor(env: WorkerEnv, ctx: ExecutionContext): Promise<AppDeps> {
  const alertWebhookUrl = typeof env["ALERT_WEBHOOK_URL"] === "string" && env["ALERT_WEBHOOK_URL"].length > 0
    ? env["ALERT_WEBHOOK_URL"]
    : undefined;
  const alertAuthHeader = typeof env["ALERT_WEBHOOK_AUTH_HEADER"] === "string" && env["ALERT_WEBHOOK_AUTH_HEADER"].length > 0
    ? env["ALERT_WEBHOOK_AUTH_HEADER"]
    : undefined;
  const alertSink = alertWebhookUrl !== undefined
    ? httpAlertSink({
        url: alertWebhookUrl,
        ...(alertAuthHeader !== undefined ? { headers: { authorization: alertAuthHeader } } : {})
      })
    : undefined;
  const logger = consoleLogger({
    format: "json",
    minLevel: "info",
    baseFields: { service: "crypto-gateway", runtime: "workers" },
    ...(alertSink !== undefined ? { alertSink } : {})
  });
  const cache = cfKvAdapter(env.KV);
  // Prefer the Cloudflare built-in ratelimits binding per scope when it's
  // declared in wrangler.jsonc — that path is atomic at the edge, free, and
  // serves the same correctness guarantee the old DO adapter was doing
  // much more expensively. Any scope whose binding is absent falls through
  // to the cache-backed limiter (documented over-admit under burst) so
  // operators can roll the bindings out one at a time.
  const cfBindings: Record<string, RateLimit | undefined> = {
    ...(env.RATE_LIMIT_ADMIN !== undefined ? { admin: env.RATE_LIMIT_ADMIN } : {}),
    ...(env.RATE_LIMIT_CHECKOUT !== undefined ? { checkout: env.RATE_LIMIT_CHECKOUT } : {}),
    ...(env.RATE_LIMIT_WEBHOOK_INGEST !== undefined ? { "webhook-ingest": env.RATE_LIMIT_WEBHOOK_INGEST } : {}),
    ...(env.RATE_LIMIT_MERCHANT_API !== undefined ? { "merchant-api": env.RATE_LIMIT_MERCHANT_API } : {})
  };
  const boundScopes = Object.keys(cfBindings);
  const rateLimiter = boundScopes.length > 0
    ? cloudflareRateLimiter({ bindings: cfBindings, fallback: cacheBackedRateLimiter(cache) })
    : cacheBackedRateLimiter(cache);
  if (boundScopes.length === 0) {
    logger.warn("no RATE_LIMIT_* bindings present; using cache-backed limiter for all scopes (may over-admit under burst)");
  } else if (boundScopes.length < 4) {
    logger.info("partial CF rate-limit bindings; unbound scopes fall back to cache-backed", {
      bound: boundScopes
    });
  }

  // Real-chain adapters wire below based on creds (Alchemy-optional EVM,
  // Solana, Tron). The synthetic dev adapter is intentionally NOT wired
  // here — it's a test-only fixture, never shipped to a running server.
  const chains: ChainAdapter[] = [];
  const detectionStrategies: Record<number, ReturnType<typeof rpcPollDetection>> = {};
  const activeAlchemyChainIds: number[] = [];
  const alchemyApiKey = typeof env["ALCHEMY_API_KEY"] === "string" ? env["ALCHEMY_API_KEY"] : undefined;
  if (alchemyApiKey !== undefined && alchemyApiKey.length > 0) {
    const chainIdsRaw = typeof env["ALCHEMY_CHAINS"] === "string" ? env["ALCHEMY_CHAINS"] : undefined;
    const chainIds = parseAlchemyChainsEnv(chainIdsRaw);
    chains.push(
      evmChainAdapter({ chainIds, rpcUrls: alchemyRpcUrls(alchemyApiKey, chainIds) })
    );
    for (const chainId of chainIds) {
      detectionStrategies[chainId] = rpcPollDetection();
      activeAlchemyChainIds.push(chainId);
    }
    logger.info("Alchemy EVM chains wired", { chainIds });
  }

  // Tron wiring. Same selection logic as node.ts — trongrid primary,
  // Alchemy fallback for /wallet/* when both keys are set.
  const trongridApiKey = typeof env["TRONGRID_API_KEY"] === "string" ? env["TRONGRID_API_KEY"] : undefined;
  const tronNetwork = env["TRON_NETWORK"] === "nile" ? "nile" : "mainnet";
  const tronPollIntervalMsRaw = typeof env["TRON_POLL_INTERVAL_MS"] === "string" ? env["TRON_POLL_INTERVAL_MS"] : undefined;
  const tronPollIntervalMs = tronPollIntervalMsRaw !== undefined ? Number.parseInt(tronPollIntervalMsRaw, 10) : undefined;
  const tronWiringInput: Parameters<typeof wireTron>[0] = {
    network: tronNetwork,
    logger
  };
  if (trongridApiKey !== undefined && trongridApiKey.length > 0) tronWiringInput.trongridApiKey = trongridApiKey;
  if (alchemyApiKey !== undefined && alchemyApiKey.length > 0) tronWiringInput.alchemyApiKey = alchemyApiKey;
  if (tronPollIntervalMs !== undefined && Number.isFinite(tronPollIntervalMs)) {
    tronWiringInput.pollIntervalMs = tronPollIntervalMs;
  }
  const tronsaveApiKey = typeof env["TRONSAVE_API_KEY"] === "string" ? env["TRONSAVE_API_KEY"] : undefined;
  if (tronsaveApiKey !== undefined && tronsaveApiKey.length > 0) {
    tronWiringInput.tronsaveApiKey = tronsaveApiKey;
  }
  const temApiKey = typeof env["TRONENERGY_MARKET_API_KEY"] === "string" ? env["TRONENERGY_MARKET_API_KEY"] : undefined;
  const temAddress = typeof env["TRONENERGY_MARKET_ADDRESS"] === "string" ? env["TRONENERGY_MARKET_ADDRESS"] : undefined;
  if (temApiKey !== undefined && temApiKey.length > 0) {
    tronWiringInput.tronEnergyMarketApiKey = temApiKey;
    if (temAddress !== undefined && temAddress.length > 0) tronWiringInput.tronEnergyMarketAddress = temAddress;
  }
  if (tronWiringInput.tronsaveApiKey !== undefined || tronWiringInput.tronEnergyMarketApiKey !== undefined) {
    const maxUnit = Number.parseInt(typeof env["TRONSAVE_MAX_UNIT_PRICE_SUN"] === "string" ? env["TRONSAVE_MAX_UNIT_PRICE_SUN"] : "", 10);
    if (Number.isFinite(maxUnit) && maxUnit >= 1) tronWiringInput.tronsaveMaxUnitPriceSun = maxUnit;
    const durationSec = Number.parseInt(typeof env["TRONSAVE_DURATION_SEC"] === "string" ? env["TRONSAVE_DURATION_SEC"] : "", 10);
    if (Number.isFinite(durationSec) && durationSec >= 60) tronWiringInput.tronsaveDurationSec = durationSec;
    const fillTimeoutMs = Number.parseInt(typeof env["TRONSAVE_FILL_TIMEOUT_MS"] === "string" ? env["TRONSAVE_FILL_TIMEOUT_MS"] : "", 10);
    if (Number.isFinite(fillTimeoutMs) && fillTimeoutMs >= 1000) tronWiringInput.tronsaveFillTimeoutMs = fillTimeoutMs;
    const pinnedProvider = typeof env["TRON_ENERGY_RENTAL_PROVIDER"] === "string" ? env["TRON_ENERGY_RENTAL_PROVIDER"] : undefined;
    if (pinnedProvider !== undefined && pinnedProvider.length > 0) tronWiringInput.energyRentalPinnedProvider = pinnedProvider;
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
  const solanaRpcUrl = typeof env["SOLANA_RPC_URL"] === "string" ? env["SOLANA_RPC_URL"] : undefined;
  const solanaNetwork = env["SOLANA_NETWORK"] === "devnet" ? "devnet" : "mainnet";
  const solanaWiringInput: Parameters<typeof wireSolana>[0] = {
    network: solanaNetwork,
    logger
  };
  if (solanaRpcUrl !== undefined && solanaRpcUrl.length > 0) solanaWiringInput.rpcUrl = solanaRpcUrl;
  if (alchemyApiKey !== undefined && alchemyApiKey.length > 0) solanaWiringInput.alchemyApiKey = alchemyApiKey;
  const solanaWiring = wireSolana(solanaWiringInput);
  if (solanaWiring.chainAdapter && solanaWiring.chainId !== undefined) {
    chains.push(solanaWiring.chainAdapter);
    activeAlchemyChainIds.push(solanaWiring.chainId);
  }

  // UTXO wiring (Bitcoin + Litecoin). No API creds — Esplora's public
  // endpoints handle detection + broadcast. Wired unconditionally; idle
  // when no merchant invoices on these chains. See node.ts for matching
  // rationale.
  chains.push(bitcoinChainAdapter());
  detectionStrategies[BITCOIN_CONFIG.chainId] = rpcPollDetection();
  chains.push(litecoinChainAdapter());
  detectionStrategies[LITECOIN_CONFIG.chainId] = rpcPollDetection();
  logger.info("UTXO chains wired", {
    chainIds: [BITCOIN_CONFIG.chainId, LITECOIN_CONFIG.chainId]
  });

  // Monero (XMR) inbound wiring. Conditional on MONERO_PRIMARY_ADDRESS +
  // MONERO_VIEW_KEY both being set. See node.ts for the full rationale.
  // Pure-JS detection runs on Workers identically to Node — no native
  // deps, no daemon binary required.
  const moneroPrimary = typeof env["MONERO_PRIMARY_ADDRESS"] === "string"
    ? env["MONERO_PRIMARY_ADDRESS"]
    : undefined;
  const moneroViewKeyHex = typeof env["MONERO_VIEW_KEY"] === "string"
    ? env["MONERO_VIEW_KEY"]
    : undefined;
  if (moneroPrimary !== undefined && moneroViewKeyHex !== undefined && moneroPrimary.length > 0 && moneroViewKeyHex.length > 0) {
    const networkRaw = typeof env["MONERO_NETWORK"] === "string" ? env["MONERO_NETWORK"] : "mainnet";
    // Strict enum match — a typo like `MONERO_NETWORK=stagenet1` would
    // otherwise silently boot mainnet and let the operator paste a
    // stagenet wallet against the wrong adapter (parseAddress would
    // reject it later, but we'd rather refuse here at boot).
    if (networkRaw !== "mainnet" && networkRaw !== "stagenet" && networkRaw !== "testnet") {
      throw new Error(
        `MONERO_NETWORK must be one of "mainnet" | "stagenet" | "testnet"; got '${networkRaw}'`
      );
    }
    const networkVal: "mainnet" | "stagenet" | "testnet" = networkRaw;
    const moneroChain: MoneroChainConfig =
      networkVal === "stagenet"
        ? MONERO_STAGENET_CONFIG
        : networkVal === "testnet"
          ? MONERO_TESTNET_CONFIG
          : MONERO_MAINNET_CONFIG;
    const restoreHeightVal = typeof env["MONERO_RESTORE_HEIGHT"] === "string"
      ? Number(env["MONERO_RESTORE_HEIGHT"])
      : 0;
    const restoreHeight = Number.isFinite(restoreHeightVal) && restoreHeightVal >= 0 ? restoreHeightVal : 0;
    const rpcUrlsRaw = typeof env["MONERO_RPC_URLS"] === "string" ? env["MONERO_RPC_URLS"] : undefined;
    const rpcUrls = parseMoneroRpcUrlsEnv(rpcUrlsRaw) ?? moneroChain.defaultRpcUrls;
    // Optional auth headers applied to EVERY backend (not just one) — operators
    // typically run a single commercial provider when they set this. Mixed
    // public-and-paid setups should override `MONERO_RPC_URLS` to a single
    // paid endpoint anyway, since the failover loop walks in order and the
    // paid one will respond first.
    const rpcHeadersRaw = typeof env["MONERO_RPC_HEADERS_JSON"] === "string" ? env["MONERO_RPC_HEADERS_JSON"] : undefined;
    const rpcHeaders = parseMoneroRpcHeadersEnv(rpcHeadersRaw);
    const viewKeyBytes = hexToBytes32(moneroViewKeyHex, "MONERO_VIEW_KEY");
    chains.push(
      moneroChainAdapter({
        chain: moneroChain,
        primaryAddress: moneroPrimary,
        viewKey: viewKeyBytes,
        restoreHeight,
        daemonClient: moneroDaemonRpcClient({
          backends: rpcUrls.map((u) => rpcHeaders ? { baseUrl: u, headers: rpcHeaders } : { baseUrl: u }),
          logger
        }),
        cache,
        logger
      })
    );
    detectionStrategies[moneroChain.chainId] = rpcPollDetection();
    logger.info("Monero adapter wired", {
      chainId: moneroChain.chainId,
      network: networkVal,
      restoreHeight,
      backendCount: rpcUrls.length,
      // Header NAMES only — never log values; they're auth secrets.
      authHeaderNames: rpcHeaders ? Object.keys(rpcHeaders) : []
    });
  }

  // Secrets-at-rest cipher. SECRETS_ENCRYPTION_KEY is REQUIRED in
  // production / staging — Workers don't run loadConfig the way node.ts
  // does, so we enforce the same guard here at cipher construction.
  // Falling through to devCipher in prod would encrypt every secret with
  // a publicly-known zero key; refuse to boot instead.
  const secretsEncryptionKey = typeof env["SECRETS_ENCRYPTION_KEY"] === "string" ? env["SECRETS_ENCRYPTION_KEY"] : undefined;
  const nodeEnv = typeof env["NODE_ENV"] === "string" ? env["NODE_ENV"] : undefined;
  const isProdLike = nodeEnv === "production" || nodeEnv === "staging";
  if (isProdLike && (secretsEncryptionKey === undefined || secretsEncryptionKey.length === 0)) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY is required when NODE_ENV=production or staging. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  const secretsCipher = secretsEncryptionKey !== undefined && secretsEncryptionKey.length > 0
    ? await makeSecretsCipher(secretsEncryptionKey)
    : await devCipher();
  if (secretsEncryptionKey === undefined || secretsEncryptionKey.length === 0) {
    logger.warn("SECRETS_ENCRYPTION_KEY not set; using dev cipher (NOT safe for production)");
  }

  // Turso (libSQL) client — REQUIRED. The `@libsql/client` package
  // auto-routes to `./web.js` on workerd via its conditional exports, giving
  // us HTTP-only Turso access with no node:net deps. Migrations are applied
  // CLI-side on Workers deploys (see README).
  if (typeof env.TURSO_URL !== "string" || env.TURSO_URL.length === 0) {
    throw new Error(
      "TURSO_URL is required — set via `wrangler secret put TURSO_URL`. " +
        "D1 is no longer supported (see the 2026-Q1 Turso migration note)."
    );
  }
  if (typeof env.TURSO_AUTH_TOKEN !== "string" || env.TURSO_AUTH_TOKEN.length === 0) {
    throw new Error(
      "TURSO_AUTH_TOKEN is required — set via `wrangler secret put TURSO_AUTH_TOKEN`. " +
        "Get it from `turso db tokens create <db-name>`."
    );
  }
  const libsqlClient = createLibsqlClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });
  const db = createDb(libsqlClient);
  const feeWalletStore = dbFeeWalletStore({ db, secretsCipher, clock: { now: () => new Date() } });
  let alchemy: AppDeps["alchemy"];
  const alchemyNotifyToken = readAlchemyNotifyTokenFromEnv(env as unknown as Record<string, unknown>, logger);
  if (alchemyNotifyToken !== undefined) {
    const sweep = makeAlchemySyncSweep({
      adminClient: alchemyAdminClient({ authToken: alchemyNotifyToken }),
      registryStore: dbAlchemyRegistryStore(db),
      subscriptionStore: dbAlchemySubscriptionStore(db),
      logger
    });
    alchemy = { syncAddresses: sweep };
  }

  // BlockCypher push-detection accelerator (mirror of node.ts wiring).
  // Per-chain config: each UTXO chain registered in `chains` reads its own
  //   BLOCKCYPHER_TOKEN_<SLUG> + BLOCKCYPHER_CALLBACK_URL_<SLUG>
  // env-var pair (e.g. BLOCKCYPHER_TOKEN_BITCOIN, _LITECOIN, _BITCOIN_TESTNET).
  // Setting only one of the pair is a hard boot error. Chains BlockCypher
  // doesn't cover (LTC testnet, blockcypherCoinPath=null) are skipped silently.
  let blockcypher: AppDeps["blockcypher"];
  let blockcypherPushStrategy: ReturnType<typeof blockcypherNotifyDetection> | undefined;
  const workerSecrets = workersEnvSecrets(env as unknown as Record<string, unknown>);
  const blockcypherConfigs = loadBlockcypherChainConfigs({
    secrets: workerSecrets,
    chains,
    logger
  });
  if (blockcypherConfigs.size > 0) {
    const sweep = makeBlockcypherSyncSweep({
      store: dbBlockcypherSubscriptionStore(db),
      configByChainId: blockcypherConfigs,
      logger,
      clock: { now: () => new Date() }
    });
    blockcypher = {
      syncSubscriptions: sweep,
      configuredChainIds: new Set(blockcypherConfigs.keys())
    };
    blockcypherPushStrategy = blockcypherNotifyDetection(
      async (innerDeps, chainId) => {
        // Owned addresses come from the per-family join table, NOT
        // invoices.receiveAddress. On a multi-currency invoice the Litecoin leg
        // is frequently a SECONDARY family: invoices.chainId/receiveAddress hold
        // the PRIMARY (e.g. an EVM stablecoin), so a primary-only lookup would
        // never contain the LTC address — the BlockCypher push arrives, matches
        // nothing, and silently does nothing. invoice_receive_addresses carries
        // one row per family keyed by the specific chainId (mirrors the
        // subscription tracker, which subscribes every receive address).
        const { invoiceReceiveAddresses } = await import("../db/schema.js");
        const { eq } = await import("drizzle-orm");
        const rows = await innerDeps.db
          .select({ address: invoiceReceiveAddresses.address })
          .from(invoiceReceiveAddresses)
          .where(eq(invoiceReceiveAddresses.chainId, chainId));
        const set = new Set<string>();
        for (const r of rows) set.add(r.address.toLowerCase());
        const cfg = utxoConfigForChainId(chainId);
        const native = cfg?.nativeSymbol ?? "BTC";
        return { chainId, nativeSymbol: native as "BTC" | "LTC", ourAddresses: set };
      }
    );
    const enabledSlugs = Array.from(blockcypherConfigs.values()).map((c) => c.slug);
    logger.info("BlockCypher accelerator wired (per-chain)", {
      chains: enabledSlugs,
      chainCount: blockcypherConfigs.size
    });
  }

  return {
    db,
    cache,
    jobs: waitUntilJobs(ctx),
    secrets: workerSecrets,
    secretsCipher,
    feeWalletStore,
    signerStore: hdSignerStore({
      masterSeed: env.MASTER_SEED,
      chains,
      feeWalletStore,
      secretsCipher,
      db
    }),
    priceOracle: selectPriceOracle({
      ...(env["PRICE_ADAPTER"] === "coingecko" || env["PRICE_ADAPTER"] === "static-peg" || env["PRICE_ADAPTER"] === "alchemy"
        ? { priceAdapter: env["PRICE_ADAPTER"] as "coingecko" | "static-peg" | "alchemy" }
        : {}),
      ...(typeof env["COINGECKO_API_KEY"] === "string" && env["COINGECKO_API_KEY"].length > 0
        ? { coingeckoApiKey: env["COINGECKO_API_KEY"] }
        : {}),
      coingeckoPlan: env["COINGECKO_PLAN"] === "pro" ? "pro" : "demo",
      ...(typeof env["COINCAP_API_KEY"] === "string" && env["COINCAP_API_KEY"].length > 0
        ? { coincapApiKey: env["COINCAP_API_KEY"] }
        : {}),
      ...(alchemyApiKey !== undefined && alchemyApiKey.length > 0 ? { alchemyApiKey } : {}),
      ...(env["DISABLE_COINGECKO"] === "1" ? { disableCoingecko: true } : {}),
      ...(env["DISABLE_COINCAP"] === "1" ? { disableCoincap: true } : {}),
      ...(env["DISABLE_BINANCE"] === "1" ? { disableBinance: true } : {}),
      ...(env["DISABLE_ALCHEMY"] === "1" ? { disableAlchemy: true } : {}),
      cache,
      logger
    }),
    webhookDispatcher: inlineFetchDispatcher({
      allowHttp: env["NODE_ENV"] === "development" || env["NODE_ENV"] === "test"
    }),
    webhookDeliveryStore: dbWebhookDeliveryStore(db),
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits: {
      merchantPerMinute: envNumber(env, "RATE_LIMIT_MERCHANT_PER_MINUTE", 1000),
      checkoutPerMinute: envNumber(env, "RATE_LIMIT_CHECKOUT_PER_MINUTE", 60),
      webhookIngestPerMinute: envNumber(env, "RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE", 300),
      adminPerMinute: envNumber(env, "RATE_LIMIT_ADMIN_PER_MINUTE", 30),
      trustedIpHeaders: parseTrustedIpHeaders(env["TRUSTED_IP_HEADERS"], ["cf-connecting-ip"])
    },
    chains,
    detectionStrategies,
    pushStrategies: {
      "alchemy-notify": alchemyNotifyDetection(),
      ...(blockcypherPushStrategy !== undefined
        ? { "blockcypher-notify": blockcypherPushStrategy }
        : {})
    },
    clock: { now: () => new Date() },
    ...(alchemy !== undefined ? { alchemy } : {}),
    ...(blockcypher !== undefined ? { blockcypher } : {}),
    alchemySubscribableChainsByFamily: alchemyChainsByFamily(activeAlchemyChainIds),
    confirmationThresholds: parseFinalityOverridesEnv(
      typeof env["FINALITY_OVERRIDES"] === "string" ? env["FINALITY_OVERRIDES"] : undefined
    ),
    ...(parsePayoutConcurrency(env["PAYOUT_CONCURRENCY_PER_CHAIN"]) !== undefined
      ? { payoutConcurrencyPerChain: parsePayoutConcurrency(env["PAYOUT_CONCURRENCY_PER_CHAIN"])! }
      : {}),
    fastPayoutExecutionEnabled: true,
    ...(parseFeeTierEnv(env["INTERNAL_CONSOLIDATION_FEE_TIER"]) !== undefined
      ? { internalConsolidationFeeTier: parseFeeTierEnv(env["INTERNAL_CONSOLIDATION_FEE_TIER"])! }
      : {}),
    ...(parseNonNegNumberEnv(env["CONSOLIDATION_DUST_GAS_MULTIPLIER"]) !== undefined
      ? { consolidationDustGasMultiplier: parseNonNegNumberEnv(env["CONSOLIDATION_DUST_GAS_MULTIPLIER"])! }
      : {}),
    ...(parseNonNegNumberEnv(env["CONSOLIDATION_TOPUP_CUSHION_PERCENT"]) !== undefined
      ? { consolidationTopUpCushionPercent: parseNonNegNumberEnv(env["CONSOLIDATION_TOPUP_CUSHION_PERCENT"])! }
      : {})
  };
}

// Validate an optional fee-tier env value; undefined when unset/invalid so the
// consumer falls back to its built-in "low" default.
function parseFeeTierEnv(raw: unknown): "low" | "medium" | "high" | undefined {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : undefined;
}

// Parse an optional non-negative number env value; undefined when unset/invalid.
function parseNonNegNumberEnv(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// Parse the env-string into a positive integer. Returns undefined to fall
// back to the in-code default (16) — keeps Workers' ~50-subrequest budget
// from blowing up if an operator misconfigures the env.
function parsePayoutConcurrency(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 64 || !Number.isInteger(n)) return undefined;
  return n;
}

function envNumber(env: WorkerEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function parseTrustedIpHeaders(raw: unknown, fallback: readonly string[]): readonly string[] {
  if (typeof raw !== "string") return fallback;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

// Boot-error handler shared by fetch + scheduled. Any failure inside depsFor
// (missing SECRETS_ENCRYPTION_KEY in prod, missing TURSO_URL / TURSO_AUTH_TOKEN,
// bad env) would otherwise surface as an opaque 500 — log with structured
// fields and best-effort POST to ALERT_WEBHOOK_URL if it's set, so ops know
// cold-boot failed rather than discovering via a paging merchant.
async function reportBootFailure(err: unknown, env: WorkerEnv): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const payload = {
    ts: new Date().toISOString(),
    level: "fatal",
    msg: "worker boot failed",
    service: "crypto-gateway",
    runtime: "workers",
    error: message,
    ...(stack !== undefined ? { stack } : {})
  };
  // Log to the Workers runtime first — that always works.
  console.error(JSON.stringify(payload));

  const alertUrl = typeof env["ALERT_WEBHOOK_URL"] === "string" ? env["ALERT_WEBHOOK_URL"] : undefined;
  if (alertUrl === undefined || alertUrl.length === 0) return;
  const authHeader = typeof env["ALERT_WEBHOOK_AUTH_HEADER"] === "string" ? env["ALERT_WEBHOOK_AUTH_HEADER"] : undefined;
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

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    let deps: AppDeps;
    try {
      deps = await depsFor(env, ctx);
    } catch (err) {
      await reportBootFailure(err, env);
      return new Response(
        JSON.stringify({ error: "service misconfigured", detail: "see server logs" }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
    const app = buildApp(deps);
    return app.fetch(request) as Promise<Response>;
  },

  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    // Delegate to the runtime-agnostic runner so every scheduler (Workers
    // scheduled, Node cron, Deno.cron, Vercel cron) runs the identical job
    // set — including `alchemy.syncAddresses` when configured. runScheduledJobs
    // catches per-step errors and returns outcomes; we surface them via logger
    // so the Workers runtime sees them.
    let deps: AppDeps;
    try {
      deps = await depsFor(env, ctx);
    } catch (err) {
      await reportBootFailure(err, env);
      return;
    }
    // Subscribers are registered by buildApp on the fetch path; the scheduled
    // path skips buildApp entirely (no Hono needed) but MUST still wire them,
    // otherwise webhook events published by the cron sweepers
    // (invoice.completed, invoice.payment_confirmed, payout.*) reach an
    // empty bus and never insert into webhook_deliveries.
    registerEventSubscribers(deps);
    const result = await runScheduledJobs(deps);
    for (const [name, outcome] of Object.entries(result)) {
      if (outcome && !outcome.ok) {
        deps.logger.error("scheduled job failed", { job: name, error: outcome.error });
      }
    }
  }
};

// Decode a 64-hex-char string into 32 bytes. Throws with a stable error
// shape if the env var is the wrong length or has non-hex characters —
// caught at boot rather than producing a silently-broken adapter.
function hexToBytes32(hex: string, varName: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length !== 64) {
    throw new Error(`${varName} must be 64 hex characters (32 bytes); got ${stripped.length}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(stripped)) {
    throw new Error(`${varName} contains non-hex characters`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
