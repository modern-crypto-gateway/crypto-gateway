import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, type App } from "../../app.js";
import { memoryCacheAdapter } from "../../adapters/cache/memory.adapter.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { libsqlAdapter } from "../../adapters/db/libsql.adapter.js";
import { promiseSetJobs } from "../../adapters/jobs/promise-set.adapter.js";
import { staticPegPriceOracle } from "../../adapters/price-oracle/static-peg.adapter.js";
import { memorySignerStore } from "../../adapters/signer-store/memory.adapter.js";
import { capturingWebhookDispatcher, type CapturingDispatcher } from "../../adapters/webhook-delivery/noop.adapter.js";
import { sha256Hex } from "../../adapters/crypto/subtle.js";
import { bufferingLogger, type BufferingLogger } from "../../adapters/logging/console.adapter.js";
import { cacheBackedRateLimiter } from "../../adapters/rate-limit/cache-backed.adapter.js";
import type { AppDeps, RateLimitConfig } from "../../core/app-deps.js";
import { createInMemoryEventBus } from "../../core/events/in-memory-bus.js";
import type { SecretsProvider } from "../../core/ports/secrets.port.js";

export interface BootTestAppOptions {
  // Fixed clock for deterministic timestamps in assertions. Defaults to Date.now().
  now?: Date;
  // Overrides merged into the secrets provider. `MASTER_SEED` defaults to "test-seed".
  secretsOverrides?: Record<string, string>;
  // Chain adapters to register. Defaults to a single dev adapter on chainId 999.
  chains?: AppDeps["chains"];
  // Per-chain detection strategies. Defaults to none (push-only model for tests).
  detectionStrategies?: AppDeps["detectionStrategies"];
  // Push-based DetectionStrategies keyed by provider name. Defaults to none.
  pushStrategies?: AppDeps["pushStrategies"];
  // Custom webhook dispatcher. Defaults to a capturing dispatcher the test
  // can read via `booted.webhookDispatcher.calls`.
  webhookDispatcher?: AppDeps["webhookDispatcher"];
  // Pre-insert merchant rows so tests don't have to seed via SQL. Each merchant
  // gets a deterministic plaintext API key `sk_test_<id>` whose SHA-256 is
  // persisted as api_key_hash. The plaintext is exposed via `booted.apiKeys`.
  merchants?: ReadonlyArray<{
    id: string;
    name?: string;
    active?: boolean;
    webhookUrl?: string;
    webhookSecret?: string;
  }>;
  // Rate-limit overrides. Defaults are set high enough that existing integration
  // tests never trip them; rate-limit-specific tests pass small numbers here.
  rateLimits?: Partial<RateLimitConfig>;
  // When provided, wires the Alchemy subscription tracker (subscribes to
  // order events, writes rows to alchemy_address_subscriptions) and exposes
  // the caller-supplied sync function as `deps.alchemy.syncAddresses`.
  // Most tests leave this undefined so the Alchemy path is silent.
  alchemy?: AppDeps["alchemy"];
}

export interface BootedTestApp {
  app: App;
  deps: AppDeps;
  // Only set when the default capturing dispatcher is in use. If the test
  // supplied its own dispatcher via `options.webhookDispatcher`, this is undefined.
  webhookDispatcher?: CapturingDispatcher;
  // Plaintext API keys for each seeded merchant, keyed by merchant id.
  // Tests pass these in the Authorization header.
  apiKeys: Readonly<Record<string, string>>;
  // Buffering logger attached to deps — tests can inspect `logger.entries`
  // to assert that a specific log line fired.
  logger: BufferingLogger;
  // Close underlying resources (libSQL :memory: client).
  close: () => Promise<void>;
}

// Helper for tests that post new orders against the authenticated API.
export async function createOrderViaApi(
  booted: BootedTestApp,
  args: {
    merchantId?: string;
    apiKey?: string;
    chainId?: number;
    token?: string;
    amountRaw?: string;
    fiatAmount?: string;
    fiatCurrency?: string;
  }
): Promise<{ id: string; receiveAddress: string; status: string; [k: string]: unknown }> {
  const merchantId = args.merchantId ?? "00000000-0000-0000-0000-000000000001";
  const apiKey = args.apiKey ?? booted.apiKeys[merchantId];
  if (!apiKey) throw new Error(`No API key seeded for merchant ${merchantId}`);
  const body: Record<string, unknown> = {
    chainId: args.chainId ?? 999,
    token: args.token ?? "DEV"
  };
  if (args.amountRaw !== undefined) body["amountRaw"] = args.amountRaw;
  if (args.fiatAmount !== undefined) body["fiatAmount"] = args.fiatAmount;
  if (args.fiatCurrency !== undefined) body["fiatCurrency"] = args.fiatCurrency;
  const res = await booted.app.fetch(
    new Request("http://test.local/api/v1/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    })
  );
  if (res.status !== 201) {
    const err = await res.text();
    throw new Error(`createOrderViaApi: unexpected status ${res.status}: ${err}`);
  }
  const parsed = (await res.json()) as { order: { id: string; receiveAddress: string; status: string } };
  return parsed.order;
}

// Boots a real `buildApp()` with libSQL :memory: + memory cache + promise-set
// jobs + dev chain adapter + capturing webhook dispatcher. Integration tests
// exercise HTTP routes via `app.fetch(new Request(...))` against this bundle.

export async function bootTestApp(options: BootTestAppOptions = {}): Promise<BootedTestApp> {
  const db = libsqlAdapter({ url: ":memory:" });

  const here = dirname(fileURLToPath(import.meta.url));
  // src/__tests__/helpers/boot.ts  ->  repo root is three dirs up.
  const schemaPath = resolve(here, "..", "..", "..", "migrations", "schema.sql");
  await db.exec(readFileSync(schemaPath, "utf8"));

  // Seed merchants + generate their plaintext API keys.
  const merchants =
    options.merchants ?? [
      { id: "00000000-0000-0000-0000-000000000001", name: "Test Merchant", active: true }
    ];
  const seedNow = options.now !== undefined ? options.now.getTime() : Date.now();
  const apiKeys: Record<string, string> = {};
  for (const m of merchants) {
    // Deterministic per-id plaintext key so tests can hard-code if they want,
    // but prefer `booted.apiKeys[id]` to stay decoupled from the format.
    const plaintextKey = `sk_test_${m.id.replace(/-/g, "")}`;
    const apiKeyHash = await sha256Hex(plaintextKey);
    apiKeys[m.id] = plaintextKey;
    await db
      .prepare(
        `INSERT INTO merchants (id, name, api_key_hash, webhook_url, webhook_secret_hash, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        m.id,
        m.name ?? "Test Merchant",
        apiKeyHash,
        m.webhookUrl ?? null,
        m.webhookSecret ?? null,
        m.active === false ? 0 : 1,
        seedNow,
        seedNow
      )
      .run();
  }

  const secretsOverrides: Record<string, string> = { MASTER_SEED: "test-seed", ...(options.secretsOverrides ?? {}) };
  const secrets: SecretsProvider = {
    getRequired(key) {
      const v = secretsOverrides[key];
      if (v === undefined || v === "") {
        throw new Error(`Required secret ${key} not set`);
      }
      return v;
    },
    getOptional(key) {
      const v = secretsOverrides[key];
      return v === "" ? undefined : v;
    }
  };

  const capturingDispatcher = options.webhookDispatcher === undefined ? capturingWebhookDispatcher() : undefined;
  const logger = bufferingLogger();
  const cache = memoryCacheAdapter();
  const rateLimits: RateLimitConfig = {
    merchantPerMinute: options.rateLimits?.merchantPerMinute ?? 10_000,
    checkoutPerMinute: options.rateLimits?.checkoutPerMinute ?? 10_000,
    webhookIngestPerMinute: options.rateLimits?.webhookIngestPerMinute ?? 10_000
  };
  // The memory cache honors arbitrary TTLs (no 60s floor), so the limiter's
  // windowing is exact in tests.
  const rateLimiter = cacheBackedRateLimiter(cache, { minTtlSeconds: 1 });

  const deps: AppDeps = {
    db,
    cache,
    jobs: promiseSetJobs(),
    secrets,
    signerStore: memorySignerStore(),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: options.webhookDispatcher ?? capturingDispatcher!,
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits,
    chains: options.chains ?? [devChainAdapter()],
    detectionStrategies: options.detectionStrategies ?? {},
    pushStrategies: options.pushStrategies ?? {},
    clock: { now: () => options.now ?? new Date() },
    ...(options.alchemy !== undefined ? { alchemy: options.alchemy } : {})
  };

  const app = buildApp(deps);

  const booted: BootedTestApp = {
    app,
    deps,
    apiKeys,
    logger,
    close: async () => {
      await deps.jobs.drain(1_000);
    }
  };
  if (capturingDispatcher !== undefined) booted.webhookDispatcher = capturingDispatcher;
  return booted;
}
