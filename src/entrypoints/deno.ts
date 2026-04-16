import { buildApp } from "../app.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
import { evmChainAdapter } from "../adapters/chains/evm/evm-chain.adapter.js";
import { alchemyRpcUrls, parseAlchemyChainsEnv } from "../adapters/chains/evm/alchemy-rpc.js";
import { rpcPollDetection } from "../adapters/detection/rpc-poll.adapter.js";
import { libsqlAdapter } from "../adapters/db/libsql.adapter.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
import { consoleLogger } from "../adapters/logging/console.adapter.js";
import { cacheBackedRateLimiter } from "../adapters/rate-limit/cache-backed.adapter.js";
import { staticPegPriceOracle } from "../adapters/price-oracle/static-peg.adapter.js";
import { denoEnvSecrets } from "../adapters/secrets/deno-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import type { AppDeps } from "../core/app-deps.js";
import { createInMemoryEventBus } from "../core/events/in-memory-bus.js";
import { runScheduledJobs } from "../core/domain/scheduled-jobs.js";

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
  const databaseUrl = secrets.getOptional("DATABASE_URL") ?? "file:./local.db";
  const port = Number(secrets.getOptional("PORT") ?? "8787");
  const dbAuthToken = secrets.getOptional("DATABASE_TOKEN");

  const db = libsqlAdapter(
    dbAuthToken !== undefined ? { url: databaseUrl, authToken: dbAuthToken } : { url: databaseUrl }
  );

  const logger = consoleLogger({
    format: "json",
    minLevel: "info",
    baseFields: { service: "crypto-gateway", runtime: "deno" }
  });

  const cache = memoryCacheAdapter();
  const rateLimiter = cacheBackedRateLimiter(cache, { minTtlSeconds: 1 });

  const chains = [devChainAdapter()];
  const detectionStrategies: Record<number, ReturnType<typeof rpcPollDetection>> = {};
  const alchemyApiKey = secrets.getOptional("ALCHEMY_API_KEY");
  if (alchemyApiKey !== undefined) {
    const chainIds = parseAlchemyChainsEnv(secrets.getOptional("ALCHEMY_CHAINS"));
    chains.push(
      evmChainAdapter({ chainIds, rpcUrls: alchemyRpcUrls(alchemyApiKey, chainIds) })
    );
    for (const chainId of chainIds) {
      detectionStrategies[chainId] = rpcPollDetection();
    }
    logger.info("Alchemy EVM chains wired", { chainIds });
  }

  const deps: AppDeps = {
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
    chains,
    detectionStrategies,
    pushStrategies: {},
    clock: { now: () => new Date() }
  };

  const app = buildApp(deps);

  // Deno.cron is stable (Deno 1.38+) and native on Deno Deploy. Every minute
  // runs the full scheduled-jobs sequence. Named after the cadence so Deno
  // Deploy's observability panels are self-explanatory.
  Deno.cron("scheduled-jobs-1m", "* * * * *", async () => {
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
