import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import "dotenv/config";
import { migrate } from "drizzle-orm/libsql/migrator";
import { buildApp } from "../app.js";
import { runScheduledJobs } from "../core/domain/scheduled-jobs.js";
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
  litecoinChainAdapter,
  parseEsploraUrlsEnv
} from "../adapters/chains/utxo/utxo-chain.adapter.js";
import {
  BITCOIN_CONFIG,
  LITECOIN_CONFIG
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
import { utxoMempoolWsWatcher } from "../adapters/detection/utxo-mempool-ws.js";
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
  // endpoints (mempool.space / blockstream.info for BTC, litecoinspace.org
  // for LTC) handle detection and broadcast without keys. Wired
  // unconditionally; operators who don't accept BTC/LTC simply never create
  // invoices on chains 800/801, and the adapters sit idle. Detection runs
  // through the same `rpcPollDetection` path EVM uses when it's
  // Alchemy-RPC-only (no webhook source), plus the mempool WebSocket push
  // watcher started after boot (see below). ESPLORA_URLS_BITCOIN /
  // ESPLORA_URLS_LITECOIN (comma-separated) override the default backends —
  // point them at a self-hosted electrs/mempool instance for unmetered scale.
  chains.push(bitcoinChainAdapter(
    parseEsploraUrlsEnv(process.env["ESPLORA_URLS_BITCOIN"]),
    parseEsploraUrlsEnv(process.env["BLOCKBOOK_URLS_BITCOIN"])
  ));
  detectionStrategies[BITCOIN_CONFIG.chainId] = rpcPollDetection();
  chains.push(litecoinChainAdapter(
    parseEsploraUrlsEnv(process.env["ESPLORA_URLS_LITECOIN"]),
    parseEsploraUrlsEnv(process.env["BLOCKBOOK_URLS_LITECOIN"])
  ));
  detectionStrategies[LITECOIN_CONFIG.chainId] = rpcPollDetection();
  logger.info("UTXO chains wired", {
    chainIds: [BITCOIN_CONFIG.chainId, LITECOIN_CONFIG.chainId]
  });
  // BlockCypher support was removed (2026-07). A deployment still carrying
  // its env vars almost certainly expects push detection that no longer
  // exists — surface that loudly instead of silently ignoring the config.
  const staleBlockcypherVars = Object.keys(process.env).filter((k) => k.startsWith("BLOCKCYPHER"));
  if (staleBlockcypherVars.length > 0) {
    logger.warn(
      "BLOCKCYPHER_* env vars are set but BlockCypher support has been removed — vars are ignored. " +
        "UTXO push detection now uses the mempool.space/litecoinspace WebSocket watcher (UTXO_WS).",
      { vars: staleBlockcypherVars }
    );
  }

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
      "alchemy-notify": alchemyNotifyDetection()
    },
    clock,
    ...(alchemy !== undefined ? { alchemy } : {}),
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

  // In-process scheduler. Workers/Deno/Vercel get ticks from platform cron;
  // plain Node has no host cron, and without ticks NOTHING runs — no payment
  // polling, no confirmation sweeps, no invoice expiry, no payout execution.
  // Historically this entrypoint relied on an external scheduler hitting
  // POST /internal/cron/tick, which silently never happened on most deploys
  // (the root cause of "UTXO deposits never detected"). Default ON; opt out
  // with INTERNAL_CRON=off when an external scheduler owns the tick.
  let cronTimer: ReturnType<typeof setInterval> | undefined;
  if (config.internalCronEnabled) {
    let tickRunning = false;
    const tick = async (): Promise<void> => {
      // Overlap guard: a slow tick (RPC outage → timeouts) must not stack a
      // second run on top of itself — jobs assume one runner per process.
      if (tickRunning) {
        logger.warn("internal cron: previous tick still running, skipping");
        return;
      }
      tickRunning = true;
      try {
        const result = await runScheduledJobs(deps);
        const failed = Object.entries(result).filter(([, o]) => o !== undefined && !o.ok);
        if (failed.length > 0) {
          logger.warn("internal cron: tick completed with job failures", {
            failed: failed.map(([name, o]) => ({ name, error: (o as { error: string }).error }))
          });
        }
      } catch (err) {
        logger.error("internal cron: tick crashed", {
          error: err instanceof Error ? err.message : String(err)
        });
      } finally {
        tickRunning = false;
      }
    };
    cronTimer = setInterval(() => void tick(), config.internalCronIntervalMs);
    logger.info("internal cron scheduler started", {
      intervalMs: config.internalCronIntervalMs
    });
    // First tick immediately (don't wait a full interval after boot).
    void tick();
  } else {
    logger.info("internal cron disabled (INTERNAL_CRON=off) — expecting external POST /internal/cron/tick");
  }

  // Instant UTXO detection: mempool.space (BTC) / litecoinspace.org (LTC)
  // WebSocket push. Long-lived sockets are a Node-runtime capability — the
  // Workers/Deno deployments stay poll-only on their platform cron. The
  // watcher is an accelerator: detection correctness is carried by the
  // Esplora poll above; killing it (UTXO_WS=off) only costs latency.
  let utxoWs: ReturnType<typeof utxoMempoolWsWatcher> | undefined;
  const utxoWsKnob = (process.env["UTXO_WS"] ?? "").toLowerCase();
  // Same off-spellings as INTERNAL_CRON so the two sibling knobs behave alike.
  if (utxoWsKnob !== "off" && utxoWsKnob !== "0" && utxoWsKnob !== "false") {
    const wsUrlByChainId: Record<number, string> = {};
    const btcWsUrl = process.env["UTXO_WS_URL_BITCOIN"];
    if (btcWsUrl !== undefined && btcWsUrl.length > 0) {
      wsUrlByChainId[BITCOIN_CONFIG.chainId] = btcWsUrl;
    }
    const ltcWsUrl = process.env["UTXO_WS_URL_LITECOIN"];
    if (ltcWsUrl !== undefined && ltcWsUrl.length > 0) {
      wsUrlByChainId[LITECOIN_CONFIG.chainId] = ltcWsUrl;
    }
    utxoWs = utxoMempoolWsWatcher({
      deps,
      chains: [BITCOIN_CONFIG, LITECOIN_CONFIG],
      wsUrlByChainId
    });
    utxoWs.start();
  } else {
    logger.info("UTXO WebSocket watcher disabled (UTXO_WS=off) — poll-only detection");
  }

  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received; draining jobs");
    if (cronTimer !== undefined) clearInterval(cronTimer);
    utxoWs?.stop();
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
