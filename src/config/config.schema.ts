import { z } from "zod";

// One Zod schema for every env-driven piece of configuration. Entrypoints call
// `loadConfig(env)` at boot so a missing/malformed secret surfaces IMMEDIATELY
// with a clear error message — not on the first request that happens to need it.
//
// Keep this file narrow on purpose: it's the single place that knows the
// mapping between env var names and typed config fields. Adapter selection
// values (DB_ADAPTER, etc.) are declared here but the actual adapter
// construction still happens in each entrypoint — the shared wiring goes no
// further than validating that the operator's intent is consistent.

export const AppConfigSchema = z
  .object({
    environment: z.enum(["development", "production", "staging", "test"]).default("development"),
    port: z.coerce.number().int().min(1).max(65535).default(8787),

    // Adapter selection (documentation + validation; entrypoints still pick
    // concrete adapters based on the runtime they're compiled for).
    dbAdapter: z.enum(["d1", "libsql", "pg"]).optional(),
    cacheAdapter: z.enum(["cf-kv", "redis", "memory", "libsql-table"]).optional(),
    jobsAdapter: z.enum(["wait-until", "promise-set", "queue"]).optional(),
    priceAdapter: z.enum(["alchemy", "coingecko", "static-peg"]).optional(),
    detectionStrategy: z.enum(["alchemy-notify", "rpc-poll", "tron-grid-poll"]).optional(),

    // Secrets. All optional at the schema level; the `.refine` below promotes
    // required-in-production rules so the matrix stays readable.
    masterSeed: z.string().optional(),
    adminKey: z.string().optional(),
    sweepMasterKey: z.string().optional(),
    cronSecret: z.string().optional(),

    // Provider secrets.
    alchemyApiKey: z.string().optional(),
    // Comma-separated chain-id override for which chains to wire via Alchemy
    // when `alchemyApiKey` is set. Absent = default mainnet set (ETH / OP /
    // Polygon / Base / Arbitrum). Useful for narrowing to a subset, or for
    // adding testnets that aren't in the default set.
    alchemyChains: z.string().optional(),
    alchemyNotifySigningKey: z.string().optional(),

    // DB
    databaseUrl: z.string().optional(),
    databaseToken: z.string().optional(),

    // Cache
    redisUrl: z.string().optional(),

    // Rate limits. Defaults are generous enough that dev + integration tests
    // don't trip them; tune down in production via env vars.
    rateLimitMerchantPerMinute: z.coerce.number().int().min(1).default(1000),
    rateLimitCheckoutPerMinute: z.coerce.number().int().min(1).default(60),
    rateLimitWebhookIngestPerMinute: z.coerce.number().int().min(1).default(300)
  })
  .refine(
    (c) => c.environment !== "production" || (c.masterSeed !== undefined && c.masterSeed !== "" && c.masterSeed !== "dev-seed"),
    {
      message: "MASTER_SEED must be a real BIP39 mnemonic in production (not empty or the 'dev-seed' placeholder)",
      path: ["masterSeed"]
    }
  )
  .refine(
    (c) => c.environment !== "production" || (c.adminKey !== undefined && c.adminKey.length >= 32),
    { message: "ADMIN_KEY must be at least 32 characters in production", path: ["adminKey"] }
  )
  .refine(
    (c) => c.dbAdapter !== "libsql" || c.databaseUrl !== undefined,
    { message: "DATABASE_URL is required when DB_ADAPTER=libsql", path: ["databaseUrl"] }
  )
  .refine(
    (c) => c.dbAdapter !== "pg" || c.databaseUrl !== undefined,
    { message: "DATABASE_URL is required when DB_ADAPTER=pg", path: ["databaseUrl"] }
  )
  .refine(
    (c) => c.cacheAdapter !== "redis" || c.redisUrl !== undefined,
    { message: "REDIS_URL is required when CACHE_ADAPTER=redis", path: ["redisUrl"] }
  );

export type AppConfig = z.infer<typeof AppConfigSchema>;

// Typed error class so entrypoints can differentiate misconfiguration from
// runtime failures in their top-level catch handler.
export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly z.ZodIssue[]) {
    super(formatIssues(issues));
    this.name = "ConfigValidationError";
  }
}

// Map an env-var-shaped object (process.env / Workers env / Deno.env.toObject())
// to an AppConfig. Returns AppConfig or throws ConfigValidationError.
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const candidate = {
    environment: env["NODE_ENV"],
    port: env["PORT"],
    dbAdapter: env["DB_ADAPTER"],
    cacheAdapter: env["CACHE_ADAPTER"],
    jobsAdapter: env["JOBS_ADAPTER"],
    priceAdapter: env["PRICE_ADAPTER"],
    detectionStrategy: env["DETECTION_STRATEGY"],
    masterSeed: env["MASTER_SEED"],
    adminKey: env["ADMIN_KEY"],
    sweepMasterKey: env["SWEEP_MASTER_KEY"],
    cronSecret: env["CRON_SECRET"],
    alchemyApiKey: env["ALCHEMY_API_KEY"],
    alchemyChains: env["ALCHEMY_CHAINS"],
    alchemyNotifySigningKey: env["ALCHEMY_NOTIFY_SIGNING_KEY"],
    databaseUrl: env["DATABASE_URL"],
    databaseToken: env["DATABASE_TOKEN"],
    redisUrl: env["REDIS_URL"],
    rateLimitMerchantPerMinute: env["RATE_LIMIT_MERCHANT_PER_MINUTE"],
    rateLimitCheckoutPerMinute: env["RATE_LIMIT_CHECKOUT_PER_MINUTE"],
    rateLimitWebhookIngestPerMinute: env["RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE"]
  };
  // Treat empty strings as absent so Zod's optional() path matches user intent.
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (v === "" || v === undefined) continue;
    normalized[k] = v;
  }
  const result = AppConfigSchema.safeParse(normalized);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }
  return result.data;
}

function formatIssues(issues: readonly z.ZodIssue[]): string {
  const lines = issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "<root>";
    return `  - ${path}: ${i.message}`;
  });
  return `Config validation failed:\n${lines.join("\n")}`;
}
