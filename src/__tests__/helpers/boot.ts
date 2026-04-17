import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { buildApp, type App } from "../../app.js";
import { memoryCacheAdapter } from "../../adapters/cache/memory.adapter.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import { createDb, createLibsqlClient } from "../../db/client.js";
import { merchants as merchantsTable } from "../../db/schema.js";
import { devCipher } from "../../adapters/crypto/secrets-cipher.js";
import { initializePool } from "../../core/domain/pool.service.js";
import { promiseSetJobs } from "../../adapters/jobs/promise-set.adapter.js";
import { staticPegPriceOracle } from "../../adapters/price-oracle/static-peg.adapter.js";
import { hdSignerStore } from "../../adapters/signer-store/hd.adapter.js";
import { capturingWebhookDispatcher, type CapturingDispatcher } from "../../adapters/webhook-delivery/noop.adapter.js";
import { dbWebhookDeliveryStore } from "../../adapters/webhook-delivery/db-delivery-store.js";
import { sha256Hex } from "../../adapters/crypto/subtle.js";
import { bufferingLogger, type BufferingLogger } from "../../adapters/logging/console.adapter.js";
import { cacheBackedRateLimiter } from "../../adapters/rate-limit/cache-backed.adapter.js";
import type { AppDeps, RateLimitConfig } from "../../core/app-deps.js";
import { createInMemoryEventBus } from "../../core/events/in-memory-bus.js";
import type { SecretsProvider } from "../../core/ports/secrets.port.js";

export interface BootTestAppOptions {
  // Fixed clock for deterministic timestamps in assertions. Defaults to Date.now().
  now?: Date;
  // Full clock override, takes precedence over `now`. Useful for tests that
  // need to advance time across multiple calls (throttle windows, reservation
  // sweeps) without rebooting the app.
  clock?: AppDeps["clock"];
  // Overrides merged into the secrets provider. `MASTER_SEED` defaults to
  // the standard Hardhat/Anvil test mnemonic — a real BIP39 phrase, which
  // is required for Solana/Tron/EVM HD derivation to produce addresses.
  // (`@scure/bip39.mnemonicToSeedSync` validates the wordlist.)
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
  // pool.address events, writes rows to alchemy_address_subscriptions) and
  // exposes the caller-supplied sync function as `deps.alchemy.syncAddresses`.
  // Most tests leave this undefined so the Alchemy path is silent.
  alchemy?: AppDeps["alchemy"];
  // Tests that want an empty pool (exhaustion behavior, refill tests) set
  // this true to skip the default bootTestApp seeding.
  skipPoolInit?: boolean;
  // Override the default pool size seeded at boot. Tests that run many
  // concurrent invoice creations pre-seed more; throttle tests use 1 or 2.
  poolInitialSize?: number;
  // Subscribable-chains map injected into deps. Tests that exercise the
  // pool → subscription fan-out supply it; most tests leave it undefined.
  alchemySubscribableChainsByFamily?: AppDeps["alchemySubscribableChainsByFamily"];
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

// Helper for tests that post new invoices against the authenticated API.
export async function createInvoiceViaApi(
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
    new Request("http://test.local/api/v1/invoices", {
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
    throw new Error(`createInvoiceViaApi: unexpected status ${res.status}: ${err}`);
  }
  const parsed = (await res.json()) as { invoice: { id: string; receiveAddress: string; status: string } };
  return parsed.invoice;
}

// Boots a real `buildApp()` with libSQL :memory: + memory cache + promise-set
// jobs + dev chain adapter + capturing webhook dispatcher. Integration tests
// exercise HTTP routes via `app.fetch(new Request(...))` against this bundle.

export async function bootTestApp(options: BootTestAppOptions = {}): Promise<BootedTestApp> {
  const libsqlClient = createLibsqlClient({ url: ":memory:" });
  const db = createDb(libsqlClient);

  // src/__tests__/helpers/boot.ts  ->  repo root is three dirs up.
  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "drizzle",
    "migrations"
  );
  await migrate(db, { migrationsFolder });

  const secretsCipher = await devCipher();

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
    const webhookSecretCiphertext = m.webhookSecret !== undefined
      ? await secretsCipher.encrypt(m.webhookSecret)
      : null;
    await db.insert(merchantsTable).values({
      id: m.id,
      name: m.name ?? "Test Merchant",
      apiKeyHash,
      webhookUrl: m.webhookUrl ?? null,
      webhookSecretCiphertext,
      active: m.active === false ? 0 : 1,
      createdAt: seedNow,
      updatedAt: seedNow
    });
  }

  const secretsOverrides: Record<string, string> = {
    // Standard Hardhat/Anvil test mnemonic — a real BIP39 phrase. HD
    // derivation for all three families (evm/tron/solana) validates the
    // mnemonic via @scure/bip39 at refill time, so the prior "test-seed"
    // placeholder broke pool init on Solana/Tron. This value is public
    // and safe for tests (used by every Ethereum dev tool).
    MASTER_SEED: "test test test test test test test test test test test junk",
    ...(options.secretsOverrides ?? {})
  };
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
    webhookIngestPerMinute: options.rateLimits?.webhookIngestPerMinute ?? 10_000,
    adminPerMinute: options.rateLimits?.adminPerMinute ?? 10_000,
    trustedIpHeaders: options.rateLimits?.trustedIpHeaders ?? ["x-forwarded-for"]
  };
  // The memory cache honors arbitrary TTLs (no 60s floor), so the limiter's
  // windowing is exact in tests.
  const rateLimiter = cacheBackedRateLimiter(cache, { minTtlSeconds: 1 });

  const chains = options.chains ?? [devChainAdapter()];

  const deps: AppDeps = {
    db,
    cache,
    jobs: promiseSetJobs(),
    secrets,
    secretsCipher,
    signerStore: hdSignerStore({
      masterSeed: secretsOverrides["MASTER_SEED"]!,
      chains
    }),
    priceOracle: staticPegPriceOracle(),
    webhookDispatcher: options.webhookDispatcher ?? capturingDispatcher!,
    webhookDeliveryStore: dbWebhookDeliveryStore(db),
    events: createInMemoryEventBus(),
    logger,
    rateLimiter,
    rateLimits,
    chains,
    detectionStrategies: options.detectionStrategies ?? {},
    pushStrategies: options.pushStrategies ?? {},
    clock: options.clock ?? { now: () => options.now ?? new Date() },
    ...(options.alchemy !== undefined ? { alchemy: options.alchemy } : {}),
    ...(options.alchemySubscribableChainsByFamily !== undefined
      ? { alchemySubscribableChainsByFamily: options.alchemySubscribableChainsByFamily }
      : {})
  };

  const app = buildApp(deps);

  // Seed the pool so tests that create invoices don't hit PoolExhaustedError.
  // We derive families from whichever chains are wired into `deps.chains` —
  // the default test setup has only the dev chain (family="evm"), so a
  // small EVM pool suffices. Tests that wire Tron or Solana adapters get
  // those families seeded too.
  if (options.skipPoolInit !== true) {
    const families = Array.from(new Set(deps.chains.map((c) => c.family)));
    await initializePool(deps, {
      families: families.filter(
        (f): f is "evm" | "tron" | "solana" => f === "evm" || f === "tron" || f === "solana"
      ),
      initialSize: options.poolInitialSize ?? 10
    });
  }

  const booted: BootedTestApp = {
    app,
    deps,
    apiKeys,
    logger,
    close: async () => {
      await deps.jobs.drain(1_000);
      libsqlClient.close();
    }
  };
  if (capturingDispatcher !== undefined) booted.webhookDispatcher = capturingDispatcher;
  return booted;
}
