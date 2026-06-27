import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import "dotenv/config";
import { migrate } from "drizzle-orm/libsql/migrator";
import { buildApp } from "../app.js";
import { initializeMoneroPool } from "../core/domain/monero-pool.service.js";
import { createDb, createLibsqlClient } from "../db/client.js";
import { devCipher, makeSecretsCipher } from "../adapters/crypto/secrets-cipher.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { httpAlertSink } from "../adapters/logging/http-alert.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { processEnvSecrets } from "../adapters/secrets/process-env.js";
import { hdSignerStore } from "../adapters/signer-store/hd.adapter.js";
import { dbFeeWalletStore } from "../adapters/fee-wallet-store/db.adapter.js";
import { selectPriceOracle } from "../adapters/price-oracle/select-oracle.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import { dbWebhookDeliveryStore } from "../adapters/webhook-delivery/db-delivery-store.js";
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
import { dbBlockcypherSubscriptionStore } from "../adapters/detection/blockcypher-subscription-store.js";
import { makeBlockcypherSyncSweep } from "../adapters/detection/blockcypher-sync-sweep.js";
import { blockcypherNotifyDetection } from "../adapters/detection/blockcypher-notify.adapter.js";
import { loadBlockcypherChainConfigs } from "../adapters/detection/blockcypher-config.js";
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
  if (config.tronEnergyMarketApiKey !== undefined) {
    tronWiringInput.tronEnergyMarketApiKey = config.tronEnergyMarketApiKey;
    if (config.tronEnergyMarketAddress !== undefined) {
      tronWiringInput.tronEnergyMarketAddress = config.tronEnergyMarketAddress;
    }
  }
  if (config.tronEnergyMarketApiKey !== undefined || config.tronsaveApiKey !== undefined) {
    tronWiringInput.tronsaveDurationSec = config.tronsaveDurationSec;
    tronWiringInput.tronsaveFillTimeoutMs = config.tronsaveFillTimeoutMs;
    if (config.tronsaveMaxUnitPriceSun !== undefined) {
      tronWiringInput.tronsaveMaxUnitPriceSun = config.tronsaveMaxUnitPriceSun;
    }
    if (config.tronEnergyRentalProvider !== undefined) {
      tronWiringInput.energyRentalPinnedProvider = config.tronEnergyRentalProvider;
    }
  }
  if (config.tronsaveApiKey !== undefined) {
    tronWiringInput.tronsaveApiKey = config.tronsaveApiKey;
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

  // UTXO wiring (Bitcoin + Litecoin). No API creds needed — Esplora's public
  // endpoints (mempool.space + Blockstream) handle detection and broadcast
  // without keys. Wired unconditionally; operators who don't accept BTC/LTC
  // simply never create invoices on chains 800/801, and the adapters sit
  // idle. Detection runs through the same `rpcPollDetection` path EVM uses
  // when it's Alchemy-RPC-only (no webhook source).
  chains.push(bitcoinChainAdapter());
  detectionStrategies[BITCOIN_CONFIG.chainId] = rpcPollDetection();
  chains.push(litecoinChainAdapter());
  detectionStrategies[LITECOIN_CONFIG.chainId] = rpcPollDetection();
  logger.info("UTXO chains wired", {
    chainIds: [BITCOIN_CONFIG.chainId, LITECOIN_CONFIG.chainId]
  });

  // Monero (XMR) inbound wiring. Conditional: needs both MONERO_PRIMARY_ADDRESS
  // and MONERO_VIEW_KEY. Without them the adapter is simply not registered
  // (not a boot error — most deployments don't accept XMR). With them the
  // adapter validates view key ↔ address at construction so a bad paste
  // surfaces here, not on the first invoice.
  if (config.moneroPrimaryAddress !== undefined && config.moneroViewKey !== undefined) {
    const moneroChain: MoneroChainConfig =
      config.moneroNetwork === "stagenet"
        ? MONERO_STAGENET_CONFIG
        : config.moneroNetwork === "testnet"
          ? MONERO_TESTNET_CONFIG
          : MONERO_MAINNET_CONFIG;
    const rpcUrls = parseMoneroRpcUrlsEnv(config.moneroRpcUrls) ?? moneroChain.defaultRpcUrls;
    const rpcHeaders = parseMoneroRpcHeadersEnv(config.moneroRpcHeadersJson);
    const viewKeyBytes = hexToBytes32(config.moneroViewKey, "MONERO_VIEW_KEY");
    chains.push(
      moneroChainAdapter({
        chain: moneroChain,
        primaryAddress: config.moneroPrimaryAddress,
        viewKey: viewKeyBytes,
        restoreHeight: config.moneroRestoreHeight,
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
      network: config.moneroNetwork,
      restoreHeight: config.moneroRestoreHeight,
      backendCount: rpcUrls.length,
      // Header NAMES only — never log values; they're auth secrets.
      authHeaderNames: rpcHeaders ? Object.keys(rpcHeaders) : []
    });
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

  // BlockCypher push-detection accelerator. Per-chain config: each UTXO
  // chain registered in `chains` reads its own
  //   BLOCKCYPHER_TOKEN_<SLUG> + BLOCKCYPHER_CALLBACK_URL_<SLUG>
  // env-var pair (e.g. BLOCKCYPHER_TOKEN_BITCOIN, _LITECOIN, _BITCOIN_TESTNET).
  // A chain is BlockCypher-enabled iff BOTH vars are set non-empty for it.
  // Setting only one is a hard boot error (the operator clearly intended to
  // turn it on but only set half). Chains BlockCypher doesn't cover (e.g.
  // LTC testnet, blockcypherCoinPath=null) are skipped silently.
  let blockcypher: AppDeps["blockcypher"];
  let blockcypherPushStrategy: ReturnType<typeof blockcypherNotifyDetection> | undefined;
  const blockcypherConfigs = loadBlockcypherChainConfigs({ secrets, chains, logger });
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
    // The notify strategy is a thin wrapper around projectBlockcypherTx.
    // It needs to know "what addresses do we own on this chainId" — we
    // compute the set fresh per push by querying invoices.receive_address
    // for utxo-family invoices. (Most paths are sub-millisecond DB reads;
    // BlockCypher's worst-case fan-out is one push per active invoice.)
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

  const clock = { now: () => new Date() };
  const feeWalletStore = dbFeeWalletStore({ db, secretsCipher, clock });
  const deps: AppDeps = {
    db,
    cache,
    jobs: promiseSetJobs({
      onError: (err, name) => logger.error("deferred job failed", { name, error: String(err) })
    }),
    secrets,
    secretsCipher,
    feeWalletStore,
    signerStore: hdSignerStore({
      masterSeed: config.masterSeed ?? "dev-seed",
      chains,
      feeWalletStore,
      secretsCipher,
      db
    }),
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
    pushStrategies: {
      "alchemy-notify": alchemyNotifyDetection(),
      // BlockCypher strategy is registered conditionally — present only when
      // the deployment's env vars are set. The /webhooks/blockcypher route
      // returns 404 NOT_CONFIGURED when this key is absent, so a misrouted
      // BlockCypher webhook never reaches an inert handler.
      ...(blockcypherPushStrategy !== undefined
        ? { "blockcypher-notify": blockcypherPushStrategy }
        : {})
    },
    clock,
    ...(alchemy !== undefined ? { alchemy } : {}),
    ...(blockcypher !== undefined ? { blockcypher } : {}),
    alchemySubscribableChainsByFamily: alchemyChainsByFamily(activeAlchemyChainIds),
    migrationsFolder,
    confirmationThresholds: parseFinalityOverridesEnv(secrets.getOptional("FINALITY_OVERRIDES")),
    payoutConcurrencyPerChain: config.payoutConcurrencyPerChain,
    fastPayoutExecutionEnabled: true,
    internalConsolidationFeeTier: config.internalConsolidationFeeTier,
    consolidationDustGasMultiplier: config.consolidationDustGasMultiplier,
    consolidationTopUpCushionPercent: config.consolidationTopUpCushionPercent,
    moneroPoolCooldownSeconds: config.moneroPoolCooldownSeconds,
    moneroPoolInitialSize: config.moneroPoolInitialSize
  };

  // Schema-drift guard. The project's convention is to edit `0000_initial.sql`
  // in place for pre-prod schema changes — but Drizzle's migrator hashes the
  // journal `tag`, not the SQL contents, so a database that already journaled
  // `0000_initial` against an older snapshot keeps the older schema and silently
  // skips re-applying. The fee_wallets → payout_reservations refactor is the
  // canonical case: an upgraded code base + a pre-refactor DB boot OK, then
  // the first reservation insert blows up because the table doesn't exist.
  // Fail loud at startup so an operator sees the cause, not a per-payout symptom.
  await assertSchemaInSync(libsqlClient, logger);

  const app = buildApp(deps);

  // Seed the Monero subaddress pool so the first XMR invoice doesn't have to
  // pay a PoolExhaustedError + retry. Idempotent (tops up to target) and a
  // no-op when no Monero adapter is wired. Derivation is local crypto (no I/O),
  // so a failure here is a wiring bug — log it but don't block boot; the pool
  // self-heals via the on-allocation refill.
  try {
    const seeded = await initializeMoneroPool(deps);
    if (seeded.some((r) => r.added > 0)) {
      logger.info("monero subaddress pool seeded", { results: seeded });
    }
  } catch (err) {
    logger.error("monero subaddress pool seeding failed (continuing; pool self-heals on demand)", {
      error: err instanceof Error ? err.message : String(err)
    });
  }

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

// Schema-drift sentinel. Drizzle's libsql migrator hashes the journal `tag`,
// not the SQL contents — so editing `0000_initial.sql` in place after a DB has
// already journaled it leaves the old schema untouched. We can't tell whether
// the SQL drifted, but we can tell whether tables that no longer exist in the
// app's schema are still present in the DB. The fee_wallets → payout_reservations
// refactor is the canonical case; expand this list when a future refactor drops
// another table.
export async function assertSchemaInSync(
  client: { execute: (sql: string) => Promise<{ rows: unknown[] }> },
  logger: AppDeps["logger"]
): Promise<void> {
  const droppedTables = ["fee_wallets"];
  for (const table of droppedTables) {
    const result = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`
    );
    if (result.rows.length > 0) {
      const message =
        `Schema drift detected: table '${table}' still exists in this database, ` +
        `but the application schema removed it. The Drizzle migrator only re-applies ` +
        `migrations whose journal tag is new — editing 0000_initial.sql in place does NOT ` +
        `re-run on a journaled DB. Pre-prod cutover requires a fresh database (drop the file, ` +
        `or create a new Turso DB). See README § Database migrations.`;
      logger.error("startup_schema_drift", { table });
      throw new Error(message);
    }
  }
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

void main();
