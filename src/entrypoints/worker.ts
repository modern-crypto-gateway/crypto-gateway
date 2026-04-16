import type { D1Database, ExecutionContext, KVNamespace, ScheduledController } from "@cloudflare/workers-types";
import { buildApp } from "../app.js";
import { cfKvAdapter } from "../adapters/cache/cf-kv.adapter.js";
import { devChainAdapter } from "../adapters/chains/dev/dev-chain.adapter.js";
import { d1Adapter } from "../adapters/db/d1.adapter.js";
import { waitUntilJobs } from "../adapters/jobs/wait-until.adapter.js";
import { staticPegPriceOracle } from "../adapters/price-oracle/static-peg.adapter.js";
import { workersEnvSecrets } from "../adapters/secrets/workers-env.js";
import { memorySignerStore } from "../adapters/signer-store/memory.adapter.js";
import { inlineFetchDispatcher } from "../adapters/webhook-delivery/inline-fetch.adapter.js";
import type { AppDeps } from "../core/app-deps.js";
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
  ALCHEMY_NOTIFY_SIGNING_KEY?: string;

  // String env vars from wrangler.jsonc [vars]
  [key: string]: unknown;
}

function depsFor(env: WorkerEnv, ctx: ExecutionContext): AppDeps {
  return {
    db: d1Adapter(env.DB),
    cache: cfKvAdapter(env.KV),
    jobs: waitUntilJobs(ctx),
    secrets: workersEnvSecrets(env as unknown as Record<string, unknown>),
    signerStore: memorySignerStore(),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: inlineFetchDispatcher(),
    events: createInMemoryEventBus(),
    // Phase 5 boots with the dev adapter only — production deployments wire
    // the real evmChainAdapter / tronChainAdapter here with their RPC urls.
    chains: [devChainAdapter()],
    detectionStrategies: {},
    pushStrategies: {},
    clock: { now: () => new Date() }
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(depsFor(env, ctx));
    return app.fetch(request) as Promise<Response>;
  },

  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const app = buildApp(depsFor(env, ctx));
    // Run each job sequentially so one slow step doesn't starve the others'
    // error surfaces. Errors bubble — the Workers runtime logs them.
    await app.jobs["pollPayments"]?.();
    await app.jobs["confirmTransactions"]?.();
    await app.jobs["executeReservedPayouts"]?.();
    await app.jobs["confirmPayouts"]?.();
  }
};
