import type { D1Database, ExecutionContext, KVNamespace, ScheduledController } from "@cloudflare/workers-types";
import { buildApp } from "../app.js";
import { cfKvAdapter } from "../adapters/cache/cf-kv.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
import { evmChainAdapter } from "../adapters/chains/evm/evm-chain.adapter.js";
import { alchemyRpcUrls, parseAlchemyChainsEnv } from "../adapters/chains/evm/alchemy-rpc.js";
import { wireSolana } from "../adapters/chains/solana/wire.js";
import { wireTron } from "../adapters/chains/tron/wire.js";
import { alchemyNotifyDetection } from "../adapters/detection/alchemy-notify.adapter.js";
import { rpcPollDetection } from "../adapters/detection/rpc-poll.adapter.js";
import { alchemyAdminClient } from "../adapters/detection/alchemy-admin-client.js";
import { dbAlchemyRegistryStore } from "../adapters/detection/alchemy-registry-store.js";
import { readAlchemyNotifyTokenFromEnv } from "../adapters/detection/alchemy-token.js";
import { dbAlchemySubscriptionStore } from "../adapters/detection/alchemy-subscription-store.js";
import { makeAlchemySyncSweep } from "../adapters/detection/alchemy-sync-sweep.js";
import { d1Adapter } from "../adapters/db/d1.adapter.js";
import { devCipher, makeSecretsCipher } from "../adapters/crypto/secrets-cipher.js";
import { waitUntilJobs } from "../adapters/jobs/wait-until.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { staticPegPriceOracle } from "../adapters/price-oracle/static-peg.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { workersEnvSecrets } from "../adapters/secrets/workers-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import type { AppDeps } from "../core/app-deps.js";
import { runScheduledJobs } from "../core/domain/scheduled-jobs.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";

// Cloudflare Workers entrypoint. Exports { fetch, scheduled } as required by
// the Workers runtime. Each invocation constructs a fresh AppDeps using the
// request-scoped ExecutionContext (waitUntil) and the shared env binding.
//
// buildApp itself is runtime-agnostic — this file is the only Workers-aware
// code on the request path. Keeping it under ~100 lines is the plan's test of
// whether the architecture held up.

export interface WorkerEnv {
  // Bindings declared in wrangler.jsonc
  DB: D1Database;
  KV: KVNamespace;

  // Secrets (set via `wrangler secret put`)
  MASTER_SEED: string;
  ADMIN_KEY?: string;
  ALCHEMY_API_KEY?: string;
  ALCHEMY_CHAINS?: string;

  // String env vars from wrangler.jsonc [vars]
  [key: string]: unknown;
}

async function depsFor(env: WorkerEnv, ctx: ExecutionContext): Promise<AppDeps> {
  const logger = consoleLogger({
    format: "json",
    minLevel: "info",
    baseFields: { service: "crypto-gateway", runtime: "workers" }
  });
  const cache = cfKvAdapter(env.KV);
  // CF KV enforces a 60s TTL floor already, so the limiter's 60s+1 setting lands
  // at 60 anyway. Fixed-window bucketing still rolls correctly per minute.
  const rateLimiter = cacheBackedRateLimiter(cache);

  // Same Alchemy-optional pattern as the Node entrypoint: dev adapter always,
  // real EVM + RPC-poll detection when ALCHEMY_API_KEY is set.
  const chains = [devChainAdapter()];
  const detectionStrategies: Record<number, ReturnType<typeof rpcPollDetection>> = {};
  const alchemyApiKey = typeof env["ALCHEMY_API_KEY"] === "string" ? env["ALCHEMY_API_KEY"] : undefined;
  if (alchemyApiKey !== undefined && alchemyApiKey.length > 0) {
    const chainIdsRaw = typeof env["ALCHEMY_CHAINS"] === "string" ? env["ALCHEMY_CHAINS"] : undefined;
    const chainIds = parseAlchemyChainsEnv(chainIdsRaw);
    chains.push(
      evmChainAdapter({ chainIds, rpcUrls: alchemyRpcUrls(alchemyApiKey, chainIds) })
    );
    for (const chainId of chainIds) {
      detectionStrategies[chainId] = rpcPollDetection();
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
  if (solanaWiring.chainAdapter) {
    chains.push(solanaWiring.chainAdapter);
  }

  // Secrets-at-rest cipher. SECRETS_ENCRYPTION_KEY is required in
  // production — prod Workers don't run loadConfig (D1/KV-driven boot, not
  // an env-schema); the admin routes fail fast if a ciphertext can't be
  // produced, so misconfiguration is visible at first merchant creation.
  const secretsEncryptionKey = typeof env["SECRETS_ENCRYPTION_KEY"] === "string" ? env["SECRETS_ENCRYPTION_KEY"] : undefined;
  const secretsCipher = secretsEncryptionKey !== undefined && secretsEncryptionKey.length > 0
    ? await makeSecretsCipher(secretsEncryptionKey)
    : await devCipher();
  if (secretsEncryptionKey === undefined || secretsEncryptionKey.length === 0) {
    logger.warn("SECRETS_ENCRYPTION_KEY not set; using dev cipher (NOT safe for production)");
  }

  // Alchemy subscription-sync sweep (9b) — only when ALCHEMY_NOTIFY_TOKEN
  // (or the deprecated ALCHEMY_AUTH_TOKEN) is set AND a D1 binding is
  // available. Same pattern as node.ts; both entrypoints compose the same
  // adapter graph.
  const db = d1Adapter(env.DB);
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

  return {
    db,
    cache,
    jobs: waitUntilJobs(ctx),
    secrets: workersEnvSecrets(env as unknown as Record<string, unknown>),
    secretsCipher,
    signerStore: memorySignerStore(),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: inlineFetchDispatcher(),
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits: {
      merchantPerMinute: envNumber(env, "RATE_LIMIT_MERCHANT_PER_MINUTE", 1000),
      checkoutPerMinute: envNumber(env, "RATE_LIMIT_CHECKOUT_PER_MINUTE", 60),
      webhookIngestPerMinute: envNumber(env, "RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE", 300)
    },
    chains,
    detectionStrategies,
    pushStrategies: { "alchemy-notify": alchemyNotifyDetection() },
    clock: { now: () => new Date() },
    ...(alchemy !== undefined ? { alchemy } : {})
  };
}

function envNumber(env: WorkerEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(await depsFor(env, ctx));
    return app.fetch(request) as Promise<Response>;
  },

  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    // Delegate to the runtime-agnostic runner so every scheduler (Workers
    // scheduled, Node cron, Deno.cron, Vercel cron) runs the identical job
    // set — including `alchemy.syncAddresses` when configured. runScheduledJobs
    // catches per-step errors and returns outcomes; we surface them via logger
    // so the Workers runtime sees them.
    const deps = await depsFor(env, ctx);
    const result = await runScheduledJobs(deps);
    for (const [name, outcome] of Object.entries(result)) {
      if (outcome && !outcome.ok) {
        deps.logger.error("scheduled job failed", { job: name, error: outcome.error });
      }
    }
  }
};
