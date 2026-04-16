# Crypto Gateway v2 — Ground-Up Plugin/Adapter Architecture

## Context

The current codebase at `CryptoEVMGateway/` works in production and serves real merchants, but is **Cloudflare-Workers-only**, **Alchemy-only** for detection/prices, and **D1-only** for storage. Adding Tron required parallel detection / payout code paths beside EVM. Adding Solana or any new family would require touching ~10 files and ~500 lines of near-duplicate code. Each bug fix must be reapplied per family. Chain-specific branching is scattered across `payment.service.ts`, `payout.service.ts`, `reconciliation.service.ts`, and `alchemy-notify.service.ts`.

The goal is a **new project built from scratch in parallel** (viewed side-by-side via VSCode workspace) that takes everything learned from v1 and applies hexagonal architecture so every subsystem is a pluggable adapter. This lets us run the same code on Cloudflare Workers (primary), Node/Bun/Deno self-hosted, or edge runtimes (Vercel Edge, Deno Deploy), switch DB between D1 and Turso, swap Alchemy for other providers, and add new chains in **1 adapter file, 0 core edits**.

v1 stays on `main` untouched, serving production. v2 is a separate repo/dir. When v2 reaches parity on a dev deployment, merchants opt-in to the new `/api/v1/*` on the new domain on their own timeline.

## Confirmed scope (from user)

- **Target platforms**: Cloudflare Workers (primary), Node.js/Bun/Deno self-hosted, edge runtimes (Vercel Edge, Deno Deploy).
- **Pluggable subsystems**: chain adapters, DB adapter, detection provider, price oracle, KV/cache, background jobs, webhook delivery.
- **API shape**: fresh, no drop-in compat with v1; expose under `/api/v1/*` for forward versioning room.
- **Package, tooling**: TypeScript, npm, Hono router (runs on all targets).

## Architecture: hexagonal / ports-and-adapters

```
crypto-gateway/          (new repo, parallel to CryptoEVMGateway/)
├── src/
│   ├── core/                        # === PURE DOMAIN — no I/O, no runtime deps ===
│   │   ├── ports/                   # interfaces only (the "ports")
│   │   │   ├── chain.port.ts
│   │   │   ├── db.port.ts
│   │   │   ├── cache.port.ts
│   │   │   ├── jobs.port.ts
│   │   │   ├── secrets.port.ts
│   │   │   ├── price-oracle.port.ts
│   │   │   ├── detection.port.ts
│   │   │   ├── webhook-delivery.port.ts
│   │   │   └── signer-store.port.ts
│   │   ├── domain/                  # domain services: chain-agnostic, DB-agnostic
│   │   │   ├── order.service.ts
│   │   │   ├── payment.service.ts
│   │   │   ├── payout.service.ts
│   │   │   ├── reconciliation.service.ts
│   │   │   ├── webhook-composer.ts  # pure payload builder, no dispatch
│   │   │   └── state-machine.ts     # order/tx lifecycle transitions
│   │   ├── events/                  # in-process event bus (order.created, tx.confirmed, ...)
│   │   └── types/                   # domain types (Order, Transaction, Payout, ...)
│   ├── adapters/                    # === PLATFORM / PROVIDER IMPLEMENTATIONS ===
│   │   ├── chains/
│   │   │   ├── evm/                 # one folder per family
│   │   │   └── tron/
│   │   ├── db/
│   │   │   ├── d1.adapter.ts
│   │   │   ├── libsql.adapter.ts    # Turso + SQLite file + in-memory
│   │   │   └── pg.adapter.ts        # optional, behind schema-pg.sql
│   │   ├── cache/
│   │   │   ├── cf-kv.adapter.ts
│   │   │   ├── redis.adapter.ts     # ioredis + Upstash HTTP
│   │   │   ├── memory.adapter.ts
│   │   │   └── libsql-table.adapter.ts
│   │   ├── jobs/
│   │   │   ├── wait-until.adapter.ts   # CF Workers, Vercel Edge
│   │   │   └── promise-set.adapter.ts  # Node/Bun/Deno (+ optional queue.adapter.ts)
│   │   ├── detection/
│   │   │   ├── alchemy-notify.adapter.ts
│   │   │   ├── evm-rpc-poll.adapter.ts
│   │   │   └── tron-grid-poll.adapter.ts
│   │   ├── price-oracle/
│   │   │   ├── alchemy-prices.adapter.ts
│   │   │   ├── coingecko.adapter.ts
│   │   │   └── static-peg.adapter.ts   # 1:1 for stables — no network call
│   │   ├── secrets/
│   │   │   ├── workers-env.ts
│   │   │   ├── process-env.ts
│   │   │   └── deno-env.ts
│   │   ├── webhook-delivery/
│   │   │   ├── inline-fetch.adapter.ts
│   │   │   └── queue-backed.adapter.ts
│   │   └── crypto/subtle.ts         # universal Web Crypto shim
│   ├── entrypoints/                 # === RUNTIME BOOTSTRAP ===
│   │   ├── worker.ts                # CF Workers: export { fetch, scheduled }
│   │   ├── node.ts                  # @hono/node-server + node-cron
│   │   ├── deno.ts                  # Deno.serve + Deno.cron
│   │   └── vercel-edge.ts
│   ├── http/                        # === HTTP ROUTES (Hono) ===
│   │   ├── routes/
│   │   │   ├── merchant.ts
│   │   │   ├── admin.ts
│   │   │   ├── internal.ts
│   │   │   ├── checkout.ts
│   │   │   └── webhooks-ingest.ts   # e.g. /webhooks/alchemy
│   │   └── middleware/
│   ├── app.ts                       # buildApp(deps: AppDeps) — runtime-agnostic factory
│   └── __tests__/
│       ├── unit/                    # pure domain tests against mock adapters
│       ├── integration/             # app boot + fetch() — runs on node + workers
│       └── helpers/boot.ts          # bootTestApp(opts?)
├── config/
│   ├── config.schema.ts             # Zod schema for AppConfig + secrets
│   └── example.env
├── migrations/
│   ├── schema.sql                   # canonical SQLite dialect (D1 + libSQL)
│   └── schema-pg.sql                # generated; CI fails if out of sync
├── wrangler.jsonc
├── Dockerfile
├── deno.json
├── vercel.json
└── package.json
```

**Hard rule**: `core/**` compiles against a tsconfig that does NOT include `@cloudflare/workers-types` or `"node"` in `types`. Any `D1Database`, `KVNamespace`, `process.env`, `ctx.waitUntil` reference inside core fails typecheck. Only `entrypoints/**` and `adapters/**` may reference platform types.

## Core adapter interfaces (sketch)

```ts
// core/ports/chain.port.ts
export interface ChainAdapter {
  family: "evm" | "tron" | "solana";
  supportedChainIds: number[];

  // Addresses
  deriveAddress(seed: string, index: number): { address: string; privateKey: string };
  validateAddress(addr: string): boolean;
  canonicalizeAddress(addr: string): string;       // case-sensitive for Tron base58

  // Detection (used by DetectionStrategy implementations)
  scanIncoming(args: {
    chainId: number; addresses: string[]; tokens: TokenSymbol[]; sinceMs: number;
  }): Promise<DetectedTransfer[]>;
  getConfirmationStatus(chainId: number, txHash: string): Promise<{
    blockNumber?: number; confirmations: number; reverted: boolean;
  }>;

  // Payouts
  buildTransfer(args: BuildTransferArgs): Promise<UnsignedTx>;
  signAndBroadcast(unsignedTx: UnsignedTx, privateKey: string): Promise<string>;

  // Fees
  nativeSymbol(chainId: number): string;             // "ETH" / "TRX" / "SOL"
  estimateGasForTransfer(args: EstimateArgs): Promise<bigint>;  // raw native units
}

// core/ports/db.port.ts — shaped like D1 so route/service code is mechanical to port
export interface DbAdapter {
  prepare(sql: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<BatchResult[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}
export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; meta: QueryMeta }>;
  run(): Promise<{ success: boolean; meta: QueryMeta }>;
}

// core/ports/cache.port.ts
export interface CacheStore {
  get(key: string): Promise<string | null>;
  getJSON<T>(key: string): Promise<T | null>;
  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  putJSON<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor?: string }>;
}

// core/ports/jobs.port.ts
export interface JobRunner {
  defer(task: () => Promise<void>, opts?: { name?: string; timeoutMs?: number }): void;
  drain(timeoutMs: number): Promise<void>;    // no-op on Workers; used for graceful SIGTERM on Node
  inFlight(): number;
}

// core/ports/detection.port.ts — chain-agnostic detection wiring (push vs pull)
export interface DetectionStrategy {
  start?(deps: AppDeps, chainId: number): Promise<void>;            // subscribe webhook, etc.
  poll?(deps: AppDeps, chainId: number, addresses: string[]): Promise<DetectedTransfer[]>;
  handlePush?(deps: AppDeps, rawPayload: unknown): Promise<DetectedTransfer[]>;
}

// core/ports/price-oracle.port.ts
export interface PriceOracle {
  tokenToFiat(token: TokenSymbol, fiatCurrency: string): Promise<{ rate: string; at: Date }>;
  fiatToTokenAmount(fiatAmount: string, token: TokenSymbol, fiatCurrency: string, decimals: number): Promise<{ amountRaw: bigint; rate: string }>;
}

// core/ports/webhook-delivery.port.ts
export interface WebhookDispatcher {
  dispatch(args: { url: string; payload: object; secret: string; idempotencyKey: string }): Promise<{ delivered: boolean; statusCode?: number }>;
}

// core/ports/signer-store.port.ts — encrypted-at-rest fee wallet keys
export interface SignerStore {
  put(scope: SignerScope, plaintextPrivateKey: string): Promise<void>;
  get(scope: SignerScope): Promise<string>;       // decrypted
  delete(scope: SignerScope): Promise<void>;
}
```

## Composition (bootstrap pattern)

`src/app.ts` is a pure function `buildApp(deps: AppDeps) → { fetch, jobs }`. Each entrypoint is ≤100 lines — it just constructs `deps` using concrete adapters, calls `buildApp`, and wires the fetch function + schedule to the host.

```ts
// src/entrypoints/worker.ts
export default {
  async fetch(req, env, ctx) {
    const app = buildApp({
      db: d1Adapter(env.DB),
      cache: cfKvAdapter(env.KV),
      jobs: waitUntilJobs(ctx),
      secrets: workersSecrets(env),
      chains: [evmChainAdapter(env), tronChainAdapter(env)],
      priceOracle: alchemyPricesOracle(env),
      webhookDispatcher: inlineFetchDispatcher(),
      // ...
    });
    return app.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    const app = buildApp({ /* same deps with new ctx */ });
    await app.jobs.pollPayments();
    await app.jobs.expireOrders();
    await app.jobs.settleInFlight();
  },
};
```

```ts
// src/entrypoints/node.ts
const secrets = processSecrets();   // reads .env + validates via zod
const app = buildApp({
  db: await libsqlAdapter({ url: secrets.DATABASE_URL, token: secrets.DATABASE_TOKEN }),
  cache: secrets.REDIS_URL ? redisAdapter(secrets.REDIS_URL) : memoryCacheAdapter(),
  jobs: promiseSetJobs({ maxInFlight: 500 }),
  // ...same core deps
});
serve({ fetch: app.fetch, port: Number(secrets.PORT ?? 8787) });
cron.schedule("* * * * *", () => { void app.jobs.pollPayments().catch(logErr); });
process.on("SIGTERM", async () => { await app.jobs.drain(10_000); process.exit(0); });
```

Same `app.jobs.pollPayments()` runs on Workers cron and on node-cron. Because it's defined in domain/payment.service.ts against `deps`, not against `env`, it's identical across runtimes.

## Config schema

One `AppConfig` with adapter selection via env vars. Zod-validated at boot, fail-fast on missing required secrets.

```env
# Adapter selection
DB_ADAPTER=d1                  # d1 | libsql | pg
CACHE_ADAPTER=cf-kv            # cf-kv | redis | memory | libsql-table
JOBS_ADAPTER=wait-until        # wait-until | promise-set | queue
PRICE_ADAPTER=alchemy          # alchemy | coingecko | static-peg
DETECTION_STRATEGY=alchemy-notify  # alchemy-notify | rpc-poll | tron-grid-poll

# Secrets (validated by zod)
MASTER_SEED=...
ADMIN_KEY=...
SWEEP_MASTER_KEY=...
ALCHEMY_API_KEY=...
ALCHEMY_NOTIFY_TOKEN=...
DATABASE_URL=...              # when DB_ADAPTER != d1
DATABASE_TOKEN=...
REDIS_URL=...                 # when CACHE_ADAPTER = redis
```

Entry points read and validate once at startup. Workers entry point reads from `env` binding; Node reads from `process.env`; Deno reads `Deno.env`.

## Event bus (recommended)

Pure in-process event bus in `core/events/`. Domain services emit: `order.created`, `order.partial`, `order.detected`, `order.confirmed`, `order.expired`, `tx.detected`, `tx.confirmed`, `payout.submitted`, `payout.completed`. Subscribers:
- `webhookComposer` → builds payload, hands off to `webhookDispatcher`
- `reconciliation` → listens for orphan events
- `auditLogger` → structured log of every state transition

Justification: eliminates cross-cutting wiring in domain services (no more "after promoting order, also fire webhook, also release pool address, also log"). Each concern subscribes. Future features add subscribers without touching state-machine code.

## Migration story for existing data

Two workable paths; user picks when we get there:

1. **Parallel prod deployments.** v1 keeps running on `evm.wizzgift.com`. v2 deploys to a new domain (e.g. `v2.wizzgift.com`). Merchants opt-in by regenerating API keys on v2 and pointing their integrations at the new domain. Existing orders finish their lifecycle on v1; new orders go to v2. Low risk, slow migration. **Recommended default.**

2. **DbAdapter-pointed-at-existing-D1.** v2's `d1.adapter.ts` points at the existing `crypto-evm-gateway` D1 DB. v2 reads + writes the same tables (schema compatible with small additions). Harder because v2's fresh API shape differs from v1's, so webhooks would look different for the same orders. Not recommended unless we want instant migration.

Plan assumes path 1.

## Testing strategy

- **`src/__tests__/unit/`** — pure domain services tested against mock adapter implementations. Fast. Runs on Node in CI. No D1, no Alchemy, no ethers instantiation.
- **`src/__tests__/integration/`** — `bootTestApp()` boots a real `buildApp()` with `libsql(:memory:) + memory-cache + promise-set-jobs + mock-chain-adapter`, then exercises HTTP routes via `app.fetch(new Request(...))`. Covers order-create → payment-detect → webhook-dispatch end-to-end. Fast (~2s per test file).
- **Miniflare tests (subset)** — a small vitest config that runs integration tests through `@cloudflare/vitest-pool-workers` to verify D1/KV/waitUntil adapter semantics against real Workers behavior.
- **CI matrix**: Node + Workers on every PR. Bun + Deno smoke test weekly.

## Adding a new chain family (validation of the refactor)

Day-1 checklist to add Solana (or any new family):

1. Create `src/adapters/chains/solana/solana-adapter.ts` implementing `ChainAdapter`. Decisions encapsulated here: base58 addresses, SPL token vs native SOL, signing with ed25519, Helius / QuickNode RPC.
2. Create `src/adapters/detection/helius-webhook.adapter.ts` (or `solana-rpc-poll.adapter.ts`) implementing `DetectionStrategy`.
3. Add Solana tokens to `src/core/types/token-registry.ts` (chainId → TokenInfo).
4. Register the adapter in every `entrypoints/*.ts` (5-line change per entrypoint).
5. Add `migrations/` column constraints / enum values if tokens have new symbols.
6. Write `src/__tests__/unit/chains/solana.test.ts` — pure tests against a fixture RPC client.

**Zero changes** to `core/domain/payment.service.ts`, `payout.service.ts`, `reconciliation.service.ts`, or any HTTP route. If adding Solana requires touching any of those, the refactor failed — stop and rethink the contract.

## Runtime portability — per-target summary

| Runtime | DB default | Cache default | Jobs | Scheduler | DB options |
|---|---|---|---|---|---|
| CF Workers | D1 | CF-KV | `waitUntil` | `wrangler.jsonc` crons | D1 only (native binding) |
| Node/Bun | libSQL file | memory | promise-set | node-cron | libSQL (Turso), Postgres (optional) |
| Deno/Deno Deploy | libSQL HTTP | Upstash Redis | promise-set | `Deno.cron` | libSQL HTTP only |
| Vercel Edge | libSQL HTTP | Upstash Redis | `@vercel/functions` waitUntil | Vercel Cron (HTTP) | libSQL HTTP, Neon HTTP |

Enforcement against Workers-isms leaking into core (critical):

- **TypeScript boundary**: `core/tsconfig.json` doesn't include `@cloudflare/workers-types`. Any `D1Database` / `KVNamespace` / `process.env` in core = typecheck failure.
- **ESLint `no-restricted-globals`** bans `process` outside `entrypoints/node.ts` and `adapters/secrets/process-env.ts`.
- **ESLint `import/no-restricted-paths`**: `src/core/**` cannot import from `src/adapters/**` or `src/entrypoints/**`. It imports only from `src/core/ports/**`.
- **CI always runs `npm run test:node`** on every PR — if a Workers-ism slipped in, Node tests catch it.

## Implementation phases (sequencing)

Each phase is one PR on the new repo; don't start the next until the prior is green.

**Phase 0 — repo bootstrap** (half a day)
- `npm init`, TypeScript config (core + full tsconfigs), ESLint with portability rules, vitest, Hono, Zod, dotenv.
- Empty directory skeleton matching the layout above.

**Phase 1 — port contracts + core types** (1-2 days)
- Write every file under `src/core/ports/**` — interfaces only, no implementations.
- Write `src/core/types/**` — Order, Transaction, Payout, Merchant, TokenInfo, etc.
- Write zod schemas for domain types.

**Phase 2 — minimum viable adapters + first domain service** (2-3 days)
- `adapters/db/libsql.adapter.ts`, `adapters/cache/memory.adapter.ts`, `adapters/jobs/promise-set.adapter.ts`, `adapters/secrets/process-env.ts`, `adapters/crypto/subtle.ts`.
- `core/domain/order.service.ts` — create, expire, get. Tested against mock ChainAdapter + real libSQL.
- `src/app.ts` + `src/entrypoints/node.ts` minimum working Hono server. `POST /api/v1/orders` returns a payment address using an HD-derived test seed.
- First integration test passes.

**Phase 3 — chain adapters (EVM + Tron)** (4-5 days)
- `adapters/chains/evm/` and `adapters/chains/tron/` — wrap existing v1 logic (detection, payout build-sign-broadcast, gas estimation).
- Port `core/domain/payment.service.ts` (detection + confirmation state machine) against `ChainAdapter`.
- Port `core/domain/payout.service.ts` (planning + execution).
- Integration tests: mock chain adapter for predictable inputs.

**Phase 4 — detection strategies + HTTP routes + webhooks** (3-4 days)
- `adapters/detection/alchemy-notify.adapter.ts` + route `http/routes/webhooks-ingest.ts`.
- `adapters/detection/evm-rpc-poll.adapter.ts` + `tron-grid-poll.adapter.ts` (for non-Alchemy deployments).
- Port `core/domain/webhook-composer.ts` + event bus. `webhookDispatcher` adapter.
- `http/routes/merchant.ts`, `admin.ts`, `internal.ts`, `checkout.ts`.

**Phase 5 — Workers entrypoint + D1/CF-KV adapters + wrangler deploy** (1-2 days)
- `adapters/db/d1.adapter.ts`, `adapters/cache/cf-kv.adapter.ts`, `adapters/jobs/wait-until.adapter.ts`.
- `src/entrypoints/worker.ts`.
- `wrangler.jsonc`. Dev deploy + Miniflare tests pass.

**Phase 6 — Deno + Vercel Edge entrypoints** (1-2 days)
- `src/entrypoints/deno.ts`, `src/entrypoints/vercel-edge.ts`.
- `deno.json`, `vercel.json`.
- CI extended with Deno + Bun smoke tests.

**Phase 7 — Solana adapter (validation of the refactor)** (2-3 days)
- Prove that adding a new family touches only `adapters/chains/solana/`, `adapters/detection/helius-*`, and one line per entrypoint.
- If anything in `core/domain/` or `http/routes/` has to change, the refactor failed — stop and rethink.

**Phase 8 — production readiness** (2-3 days)
- Secrets validation at boot, production logging, rate limits, structured errors, OpenAPI doc generation, Postman collection, README.
- Dev deployment to `crypto-gateway-dev` Workers subdomain.
- Decision point: parallel prod deploy vs data migration path.

Total: **17-26 working days** spread over several weeks. Each phase is shippable individually.

## Critical files in v1 to study while designing (not to port line-by-line)

- [src/index.ts](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/src/index.ts) — authoritative cron dispatch pattern; defines which job functions the scheduler calls and in what order.
- [src/config/types.ts](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/src/config/types.ts) — `Env` interface is the type surface every adapter contract mirrors.
- [src/db/queries.ts](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/src/db/queries.ts) — 243 direct D1 call sites; `DbAdapter` preserves `prepare().bind().first()/all()/run()` shape so these ports mechanically.
- [src/routes/alchemy-webhook.ts](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/src/routes/alchemy-webhook.ts) — canonical `ctx.waitUntil` usage; reference for migrating all `waitUntil` sites to `deps.jobs.defer`.
- [src/services/payment.service.ts](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/src/services/payment.service.ts) — complete business logic for multi-rail detection + confirmation promotion + USD normalization. Copy the rules, not the code.
- [src/services/payout.service.ts](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/src/services/payout.service.ts) — source selection, CAS reservation, Tron TRX topup flow. Copy the rules.
- [src/db/schema.sql](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/src/db/schema.sql) — canonical table set; reuse largely unchanged under v2 with minor cleanup.
- [wrangler.jsonc](../../ClaudeCoWork/Wizzgift/stableCoinsGateway/CryptoEVMGateway/wrangler.jsonc) — reference for the new `wrangler.jsonc` on v2.

## Critical risks + open decisions

1. **Over-abstraction risk**. If `DbAdapter` becomes a generic query builder, 243 call sites need rewriting. Keep it D1-shaped.
2. **Workers-ism lint enforcement matters**. The whole multi-platform story falls apart if someone silently adds `process.env` in a domain service. The three-layer defense (tsconfig, ESLint, CI matrix) must ship in Phase 0.
3. **Solana is the refactor's proof test**. Don't design the architecture without explicitly imagining the Solana adapter. If any domain service needs to know "this is Solana" for anything other than passing a chainId, the interface is leaky.
4. **Open decision — event bus vs direct calls**. Recommended: in-process event bus. But adds indirection. If it feels over-engineered in Phase 4, simplify to direct calls and revisit.
5. **Open decision — migration path (parallel deploy vs shared DB)**. Defaulting to parallel deploy (safer). Revisit at Phase 8.
6. **Open decision — whether to support Postgres at launch**. Recommended: libSQL-only for non-Workers at launch. Add Postgres adapter only if a real merchant asks, because SQL-dialect maintenance is ongoing cost.
7. **Bundle size on Workers**. ethers.js is heavy (~500KB). Lazy-import inside chain adapters rather than top level, so non-EVM targets can tree-shake.
8. **Node 18 is EOL April 2025**. Minimum Node version is 20. Deno 1.30+. Bun 1.0+.

## Verification

End-to-end test plan for the new codebase at each major phase:

**After Phase 2**: `curl localhost:8787/health` → 200. `curl -X POST localhost:8787/api/v1/orders -d '{"chainId":1,"token":"USDC","amount":"10"}'` → 201 with a derived payment address. Order lands in libSQL.

**After Phase 4**: full order-create → simulated-tx-detection (via `http/routes/webhooks-ingest.ts` with a fixture payload) → webhook dispatched (captured by a mock dispatcher) → order confirmed. Runs on Node in under 2s.

**After Phase 5**: `wrangler deploy --env development` succeeds; `wrangler tail` shows `scheduled` ticks every minute; real D1 has the `orders` table; fetch against the deployed Worker returns the same responses as local Node integration tests.

**After Phase 6**: `npm run dev:deno`, `npm run dev:bun`, and `deployctl deploy` all produce working servers. Same integration tests pass.

**After Phase 7**: a Solana test (against a mock Solana RPC) proves detection → confirm → payout flow with zero changes to `core/domain/` or `http/routes/`.

**After Phase 8**: deployed to `crypto-gateway-dev.workers.dev`. Full smoke test in Postman (equivalent to v1's collection) passes. Ready for opt-in beta testing by real merchants.

## Out of scope (explicit)

- AWS Lambda / GCP Cloud Functions / Azure Functions.
- MySQL / PlanetScale.
- Durable Objects / long-running WebSockets.
- Zero-dependency SQLite-file production deploys (supported in dev only).
- Swapping Hono for a different router.
- Data migration from v1 to v2 (handled by parallel-deploy + opt-in merchant flow instead).
