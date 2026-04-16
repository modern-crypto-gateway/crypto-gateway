import { buildApp } from "../app.js";
import { memoryCacheAdapter } from "../adapters/cache/memory.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
import { libsqlAdapter } from "../adapters/db/libsql.adapter.js";
import { promiseSetJobs } from "../adapters/jobs/promise-set.adapter.js";
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

  const deps: AppDeps = {
    db,
    cache: memoryCacheAdapter(),
    jobs: promiseSetJobs(),
    secrets,
    signerStore: memorySignerStore(),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: inlineFetchDispatcher(),
    events: createInMemoryEventBus(),
    chains: [devChainAdapter()],
    detectionStrategies: {},
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
