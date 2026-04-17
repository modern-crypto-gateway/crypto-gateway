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
    dbAdapter: z.enum(["libsql", "turso", "pg"]).optional(),
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
    // 32 bytes hex (64 chars) — AES-256-GCM master key for encrypting secrets
    // at rest (merchant webhook HMAC secrets, Alchemy signing keys). Dev/test
    // fall back to a fixed dev key; prod/staging require a real one.
    secretsEncryptionKey: z.string().optional(),

    // Provider secrets.
    alchemyApiKey: z.string().optional(),
    // CoinGecko API key. Optional — the free tier is keyless but heavily
    // rate-limited; demo/pro keys raise that ceiling. `coingeckoPlan` selects
    // which header the adapter sends.
    coingeckoApiKey: z.string().optional(),
    coingeckoPlan: z.enum(["demo", "pro"]).default("demo"),
    // CoinCap (Messari) API key. Optional — v2 /assets is keyless in
    // practice; set this to raise the per-minute budget under load.
    coincapApiKey: z.string().optional(),
    // Per-provider opt-outs. Set to "1" to remove that source from the
    // fallback chain — useful when a jurisdiction prohibits hitting a
    // specific provider or when an operator wants deterministic-per-source
    // behavior during incident response.
    disableCoingecko: z.coerce.boolean().optional(),
    disableCoincap: z.coerce.boolean().optional(),
    disableBinance: z.coerce.boolean().optional(),
    disableAlchemy: z.coerce.boolean().optional(),
    // Comma-separated chain-id override for which chains to wire via Alchemy
    // when `alchemyApiKey` is set. Absent = default mainnet set (ETH / OP /
    // Polygon / Base / Arbitrum). Useful for narrowing to a subset, or for
    // adding testnets that aren't in the default set.
    alchemyChains: z.string().optional(),

    // Tron provider selection.
    //   - TRONGRID_API_KEY alone: detection + payouts via TronGrid (required
    //     for detection; Alchemy's Tron API doesn't expose the paginated
    //     transfer-history endpoint).
    //   - ALCHEMY_API_KEY alone: payouts only — detection is disabled with a
    //     startup warning.
    //   - Both: TronGrid primary (detection + payouts), Alchemy fallback for
    //     `/wallet/*` (build/broadcast/confirm). Frees up TronGrid's 100k/day
    //     budget to spend almost entirely on detection.
    trongridApiKey: z.string().optional(),
    // mainnet (default) or nile. Shasta is Alchemy-only; operators using Shasta
    // should rely on the Alchemy backend and accept detection-disabled mode.
    tronNetwork: z.enum(["mainnet", "nile"]).default("mainnet"),
    // Minimum interval between Tron detection polls, in ms. Defaults to
    // undefined (every cron tick). Set e.g. 300000 to cut TronGrid traffic
    // to ~1/5 of cron frequency at the cost of proportional detection lag.
    tronPollIntervalMs: z.coerce.number().int().min(0).optional(),

    // Solana wiring:
    //   - SOLANA_RPC_URL (explicit; wins over Alchemy auto-construction)
    //   - ALCHEMY_API_KEY (reused for EVM) auto-builds the Solana URL when
    //     SOLANA_RPC_URL is absent.
    //   - SOLANA_NETWORK picks mainnet vs devnet.
    // Receive-only today: SPL webhook detection works, SPL payouts are deferred.
    solanaRpcUrl: z.string().optional(),
    solanaNetwork: z.enum(["mainnet", "devnet"]).default("mainnet"),

    // DB
    databaseUrl: z.string().optional(),
    databaseToken: z.string().optional(),

    // Cache
    redisUrl: z.string().optional(),

    // Public origin of this gateway (no trailing path). The admin bootstrap
    // handler appends per-provider webhook paths (`/webhooks/alchemy`, future
    // `/webhooks/helius`, …) so operators set ONE URL for every provider.
    // Intentionally env-only — a body-supplied URL would let a leaked
    // ADMIN_KEY redirect Alchemy traffic to attacker-controlled hosts.
    gatewayPublicUrl: z.string().url().optional(),

    // Rate limits. Defaults are generous enough that dev + integration tests
    // don't trip them; tune down in production via env vars.
    rateLimitMerchantPerMinute: z.coerce.number().int().min(1).default(1000),
    rateLimitCheckoutPerMinute: z.coerce.number().int().min(1).default(60),
    rateLimitWebhookIngestPerMinute: z.coerce.number().int().min(1).default(300),
    rateLimitAdminPerMinute: z.coerce.number().int().min(1).default(30),

    // Ops alerting: when set, error-level log lines are fan-out POSTed to this
    // URL (Slack/Discord/PagerDuty-compatible JSON body). Normal logs still
    // flow to stdout/stderr; this is the page-the-oncall channel only.
    alertWebhookUrl: z.string().url().optional(),
    // Optional Authorization header value to include on alert POSTs. Useful
    // for PagerDuty ("Token token=...") or self-hosted collectors.
    alertWebhookAuthHeader: z.string().optional(),

    // Comma-separated list of which forwarded-IP headers to trust when
    // extracting the client IP for rate limiting. Order matters: the first
    // match wins. Anything not in this list is ignored — an attacker can't
    // spoof their bucket key by sending unsolicited X-Forwarded-For headers.
    //
    // Recommended values per runtime:
    //   - Cloudflare Workers : "cf-connecting-ip"
    //   - Vercel             : "x-vercel-forwarded-for,x-real-ip"
    //   - AWS ALB            : "x-forwarded-for"  (only if you terminate at the ALB)
    //   - Bare Node          : ""  (empty = trust nothing; bucket all under "anonymous")
    //
    // Default: cf-connecting-ip only. Production deployments behind other
    // proxies must override this explicitly.
    trustedIpHeaders: z.string().default("cf-connecting-ip")
  })
  // Production-grade guards also apply to `staging` so a pre-prod deploy can't
  // quietly run with placeholder secrets. Only `development` and `test` are
  // exempt — any other value (including the default "production") is treated
  // as a live environment.
  .refine(
    (c) => isRelaxedEnvironment(c.environment) || (c.masterSeed !== undefined && c.masterSeed !== "" && c.masterSeed !== "dev-seed"),
    {
      message: "MASTER_SEED must be a real BIP39 mnemonic in production/staging (not empty or the 'dev-seed' placeholder)",
      path: ["masterSeed"]
    }
  )
  .refine(
    (c) => isRelaxedEnvironment(c.environment) || (c.adminKey !== undefined && c.adminKey.length >= 32),
    { message: "ADMIN_KEY must be at least 32 characters in production/staging", path: ["adminKey"] }
  )
  .refine(
    (c) => isRelaxedEnvironment(c.environment) || (c.secretsEncryptionKey !== undefined && /^[0-9a-fA-F]{64}$/.test(c.secretsEncryptionKey)),
    {
      message: "SECRETS_ENCRYPTION_KEY must be 64 hex chars (32 bytes) in production/staging — generate via `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`",
      path: ["secretsEncryptionKey"]
    }
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

// Environments that are allowed to skip the strict production refinements
// (missing MASTER_SEED / short ADMIN_KEY). Anything else — including the
// default "production" — is treated as a live environment.
function isRelaxedEnvironment(env: string): boolean {
  return env === "development" || env === "test";
}

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
    secretsEncryptionKey: env["SECRETS_ENCRYPTION_KEY"],
    alchemyApiKey: env["ALCHEMY_API_KEY"],
    alchemyChains: env["ALCHEMY_CHAINS"],
    coingeckoApiKey: env["COINGECKO_API_KEY"],
    coingeckoPlan: env["COINGECKO_PLAN"],
    coincapApiKey: env["COINCAP_API_KEY"],
    disableCoingecko: env["DISABLE_COINGECKO"],
    disableCoincap: env["DISABLE_COINCAP"],
    disableBinance: env["DISABLE_BINANCE"],
    disableAlchemy: env["DISABLE_ALCHEMY"],
    trongridApiKey: env["TRONGRID_API_KEY"],
    tronNetwork: env["TRON_NETWORK"],
    tronPollIntervalMs: env["TRON_POLL_INTERVAL_MS"],
    solanaRpcUrl: env["SOLANA_RPC_URL"],
    solanaNetwork: env["SOLANA_NETWORK"],
    gatewayPublicUrl: env["GATEWAY_PUBLIC_URL"],
    // Compulsory Turso post-2026-Q1; the env-var names reflect that.
    // DATABASE_URL / DATABASE_TOKEN are still honored as aliases so existing
    // local .env files keep working through one release cycle.
    databaseUrl: env["TURSO_URL"] ?? env["DATABASE_URL"],
    databaseToken: env["TURSO_AUTH_TOKEN"] ?? env["DATABASE_TOKEN"],
    redisUrl: env["REDIS_URL"],
    rateLimitMerchantPerMinute: env["RATE_LIMIT_MERCHANT_PER_MINUTE"],
    rateLimitCheckoutPerMinute: env["RATE_LIMIT_CHECKOUT_PER_MINUTE"],
    rateLimitWebhookIngestPerMinute: env["RATE_LIMIT_WEBHOOK_INGEST_PER_MINUTE"],
    rateLimitAdminPerMinute: env["RATE_LIMIT_ADMIN_PER_MINUTE"],
    trustedIpHeaders: env["TRUSTED_IP_HEADERS"],
    alertWebhookUrl: env["ALERT_WEBHOOK_URL"],
    alertWebhookAuthHeader: env["ALERT_WEBHOOK_AUTH_HEADER"]
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
