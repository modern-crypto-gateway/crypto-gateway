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

    // Shared secret for the /webhooks/blockcypher/:chainId ingest route — a
    // `?token=` query param BlockCypher echoes back on every push. The route
    // is fail-closed: without this token it rejects all pushes, so the
    // refine below requires it in production/staging whenever BlockCypher
    // push detection is enabled.
    blockcypherIngestToken: z.string().optional(),
    // Derived in loadConfig (not a real env var): true when any per-chain
    // `BLOCKCYPHER_TOKEN_<SLUG>` / `BLOCKCYPHER_CALLBACK_URL_<SLUG>` pair
    // member is set, i.e. the operator intends to run BlockCypher push
    // detection on this deployment.
    blockcypherIngestEnabled: z.boolean().default(false),

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

    // Energy rental for Tron TRC-20 payouts. When any provider's credentials
    // are set, the payout executor rents delegated energy whenever that's
    // strictly cheaper than burning TRX at the chain rate, with automatic
    // fallback to burning on any provider failure — rental can lower a
    // payout's cost but never raise it. When MULTIPLE providers are
    // configured, every payout quotes all of them and the cheapest viable
    // estimate wins.
    //
    // tronenergy.market (TEM): cheapest market observed for 10-min rentals
    // (~35 SUN/unit effective vs TronSave's ~65 → cold-receiver USDT payout
    // ~5 TRX vs ~8.7). Needs BOTH the API key and the TEM account address
    // the key was issued for; orders draw from that account's prepaid
    // credit (deposit ≥10 TRX to TEM's deposit address; withdrawals are
    // locked 48h after a deposit). Mainnet only — skipped on Nile.
    tronEnergyMarketApiKey: z.string().optional(),
    tronEnergyMarketAddress: z.string().optional(),
    // TronSave: pricier but battle-tested, with server-side price caps and
    // a Nile dev environment. Orders draw from a prepaid TRX balance at
    // tronsave.io; keep the float small (1-2 weeks of payout volume) —
    // withdrawing it back is a manual support flow. TRON_NETWORK=nile
    // selects TronSave's dev environment automatically (separate key +
    // balance).
    tronsaveApiKey: z.string().optional(),
    // Pin rental to one provider by name, bypassing cheapest-wins selection
    // across configured markets. Use while a non-withdrawable prepaid
    // balance must be drained first (TronSave deposits can only be
    // recovered via manual support). Pinning a provider that isn't
    // configured disables rental (burn path) with a startup warning rather
    // than silently substituting another market. Unset = cheapest wins.
    tronEnergyRentalProvider: z.enum(["tronsave", "tronenergy.market"]).optional(),

    // The knobs below apply to energy rental as a whole (every configured
    // provider), despite the TRONSAVE_ prefix kept for compatibility with
    // existing deployments.
    //
    // Absolute cap in SUN per energy unit, applied on top of the built-in
    // dynamic ceiling (90% of the live chain burn rate). Unset = dynamic
    // ceiling only.
    tronsaveMaxUnitPriceSun: z.coerce.number().int().min(1).optional(),
    // Rental duration in seconds. Sub-day pricing is mostly flat with a
    // premium for longer windows (TronSave: 65 SUN at 10min vs 67.25 at 1h;
    // TEM: 35 SUN/day-rate for 5min-1h, billed as duration+1day), so the
    // 10min default is the cheapest practical bucket — the energy is
    // consumed seconds after the fill anyway. Raise it only if the same
    // sources broadcast repeatedly and you want leftover delegation reused
    // across payouts.
    tronsaveDurationSec: z.coerce.number().int().min(60).default(600),
    // How long the executor waits for a rental order to fill before
    // cancelling it (providers that support it) or deferring the payout to
    // the next cron tick.
    tronsaveFillTimeoutMs: z.coerce.number().int().min(1000).default(30000),

    // Solana wiring:
    //   - SOLANA_RPC_URL (explicit; wins over Alchemy auto-construction)
    //   - ALCHEMY_API_KEY (reused for EVM) auto-builds the Solana URL when
    //     SOLANA_RPC_URL is absent.
    //   - SOLANA_NETWORK picks mainnet vs devnet.
    // Receive-only today: SPL webhook detection works, SPL payouts are deferred.
    solanaRpcUrl: z.string().optional(),
    solanaNetwork: z.enum(["mainnet", "devnet"]).default("mainnet"),

    // Monero (XMR). Inbound-only in v1: the gateway holds the operator's
    // primary address + secret view key (sufficient for detection). Spend
    // key never reaches the gateway — funds settle out-of-band via the
    // operator's wallet. All four vars are optional; if MONERO_PRIMARY_ADDRESS
    // and MONERO_VIEW_KEY are both unset the adapter is simply not wired
    // and merchants can't accept XMR.
    //   - MONERO_PRIMARY_ADDRESS: 95-char base58 (mainnet) / 95-char (stagenet
    //     prefix differs but length matches). The view key MUST derive back
    //     to the public view key embedded here — boot validation throws on
    //     mismatch.
    //   - MONERO_VIEW_KEY: 64 hex chars = 32 bytes secret view key.
    //   - MONERO_NETWORK: mainnet | stagenet | testnet. Default mainnet.
    //     Validated against the address prefix at boot.
    //   - MONERO_RESTORE_HEIGHT: block to start scanning from. Default 0
    //     (re-scan everything). Operators set this to the wallet's birthday
    //     so a fresh deployment doesn't backfill years of history.
    //   - MONERO_RPC_URLS: comma-separated daemon RPC URLs. Defaults to a
    //     curated public-node list; operators can override for a self-
    //     hosted monerod or paid mirror.
    moneroPrimaryAddress: z.string().optional(),
    moneroViewKey: z.string().optional(),
    moneroNetwork: z.enum(["mainnet", "stagenet", "testnet"]).default("mainnet"),
    moneroRestoreHeight: z.coerce.number().int().nonnegative().default(0),
    moneroRpcUrls: z.string().optional(),
    // Optional. JSON object of HTTP headers (e.g. `{"api-key":"abc"}`)
    // applied to every Monero daemon RPC request. Used by commercial
    // providers (NOWNodes, Tatum). GetBlock-style URL-embedded keys do
    // not need this.
    moneroRpcHeadersJson: z.string().optional(),
    // Reusable Monero subaddress pool. Monero invoices allocate a subaddress
    // from a bounded pool and release it back on terminal for reuse (vs. the
    // legacy fresh-per-invoice counter). See monero-pool.service.ts.
    //   - MONERO_POOL_INITIAL_SIZE: subaddresses to seed per Monero chain at
    //     boot. Auto-grows under load; kept small so it stays inside the
    //     wallet's default subaddress lookahead. Default 20.
    //   - MONERO_POOL_COOLDOWN_SECONDS: minimum time a released subaddress
    //     stays out of rotation before reuse. The guard against a late payment
    //     to an expired invoice being mis-credited to the next invoice on the
    //     same subaddress. Default 3600 (60 min). A merchant's
    //     `address_cooldown_seconds` can raise this floor but never lower it.
    moneroPoolInitialSize: z.coerce.number().int().min(1).max(200).default(20),
    moneroPoolCooldownSeconds: z.coerce.number().int().nonnegative().default(3600),

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

    // Cap on concurrent `executeOnePayout` calls per chainId in a single
    // executor tick. Cross-chain runs are unconditionally parallel; this
    // bounds the within-chain fan-out so a backlog can't blow past a
    // runtime's subrequest budget (Cloudflare Workers ~50, Vercel Edge
    // similar). Default 16 is comfortable for most loads; tune lower on
    // Workers under heavy backlog.
    payoutConcurrencyPerChain: z.coerce.number().int().min(1).max(64).default(16),

    // ---- Consolidation (pool defrag) fee optimization ----
    // Internal consolidation sweeps move funds between addresses we own; they
    // have no merchant SLA, so the cheapest fee tier is the right default. The
    // tier flows through planPayout to BOTH the ERC-20 sweep and its gas
    // top-up sibling on EVM. No-op on chains without real tiering (Tron).
    // Override via INTERNAL_CONSOLIDATION_FEE_TIER.
    internalConsolidationFeeTier: z.enum(["low", "medium", "high"]).default("low"),
    // Fee-aware dust floor: skip consolidating a source whose token value is
    // worth less than (this multiplier × the estimated per-sweep gas cost), so
    // every sweep nets positive value. Applied as max(staticFloor, dynamicFloor).
    // Default 0 = OFF (opt-in) so it never silently strands balances on existing
    // deployments; set to 3–5 to enable (recommended for the lowest-fees goal —
    // 3 covers gas + headroom; higher sweeps only fuller addresses → lower fee
    // %). Override via CONSOLIDATION_DUST_GAS_MULTIPLIER.
    consolidationDustGasMultiplier: z.coerce.number().min(0).default(0),
    // Gas top-up cushion (percent) added on top of the estimated gas when an
    // EVM/Tron consolidation source needs a native top-up before a TOKEN sweep.
    // Defaults to 20% (same as merchant payouts) for headroom against baseFee
    // movement between the top-up and the sweep broadcast. (Earlier this was
    // tightened to 10% to limit "stranded dust" on single-use addresses, but
    // that rationale no longer holds: leftover top-up native is now tracked in
    // the ledger and reused by the source's next sweep, so a generous cushion
    // is free.) Override via CONSOLIDATION_TOPUP_CUSHION_PERCENT.
    consolidationTopUpCushionPercent: z.coerce.number().int().min(0).max(100).default(20),

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
  // The /webhooks/blockcypher route is fail-closed on BLOCKCYPHER_INGEST_TOKEN:
  // without it every push is rejected, so a live deployment that enabled
  // BlockCypher detection (per-chain BLOCKCYPHER_TOKEN_<SLUG> vars) but forgot
  // the ingest token would silently lose all push notifications. Require the
  // token at boot instead. Deployments not using BlockCypher are unaffected.
  .refine(
    (c) =>
      isRelaxedEnvironment(c.environment) ||
      !c.blockcypherIngestEnabled ||
      (c.blockcypherIngestToken !== undefined && c.blockcypherIngestToken.length > 0),
    {
      message:
        "BLOCKCYPHER_INGEST_TOKEN is required in production/staging when BlockCypher push detection is enabled (BLOCKCYPHER_TOKEN_<SLUG>/BLOCKCYPHER_CALLBACK_URL_<SLUG> set) — the /webhooks/blockcypher route rejects all pushes without it",
      path: ["blockcypherIngestToken"]
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

// BlockCypher push detection is enabled per chain via
// `BLOCKCYPHER_TOKEN_<SLUG>` + `BLOCKCYPHER_CALLBACK_URL_<SLUG>` pairs (see
// adapters/detection/blockcypher-config.ts). For the ingest-token refine we
// only need intent, not full validity: if EITHER member of any per-chain pair
// is set non-empty, the operator means to run BlockCypher and must also set
// BLOCKCYPHER_INGEST_TOKEN in production/staging. The legacy single-form
// `BLOCKCYPHER_TOKEN` / `BLOCKCYPHER_CALLBACK_URL` (no suffix) are no longer
// recognized anywhere and deliberately do NOT count.
function hasBlockcypherChainConfig(env: Readonly<Record<string, string | undefined>>): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if (key.startsWith("BLOCKCYPHER_TOKEN_") || key.startsWith("BLOCKCYPHER_CALLBACK_URL_")) {
      return true;
    }
  }
  return false;
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
    blockcypherIngestToken: env["BLOCKCYPHER_INGEST_TOKEN"],
    blockcypherIngestEnabled: hasBlockcypherChainConfig(env),
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
    tronEnergyMarketApiKey: env["TRONENERGY_MARKET_API_KEY"],
    tronEnergyMarketAddress: env["TRONENERGY_MARKET_ADDRESS"],
    tronEnergyRentalProvider: env["TRON_ENERGY_RENTAL_PROVIDER"],
    tronsaveApiKey: env["TRONSAVE_API_KEY"],
    tronsaveMaxUnitPriceSun: env["TRONSAVE_MAX_UNIT_PRICE_SUN"],
    tronsaveDurationSec: env["TRONSAVE_DURATION_SEC"],
    tronsaveFillTimeoutMs: env["TRONSAVE_FILL_TIMEOUT_MS"],
    solanaRpcUrl: env["SOLANA_RPC_URL"],
    solanaNetwork: env["SOLANA_NETWORK"],
    moneroPrimaryAddress: env["MONERO_PRIMARY_ADDRESS"],
    moneroViewKey: env["MONERO_VIEW_KEY"],
    moneroNetwork: env["MONERO_NETWORK"],
    moneroRestoreHeight: env["MONERO_RESTORE_HEIGHT"],
    moneroRpcUrls: env["MONERO_RPC_URLS"],
    moneroRpcHeadersJson: env["MONERO_RPC_HEADERS_JSON"],
    moneroPoolInitialSize: env["MONERO_POOL_INITIAL_SIZE"],
    moneroPoolCooldownSeconds: env["MONERO_POOL_COOLDOWN_SECONDS"],
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
    payoutConcurrencyPerChain: env["PAYOUT_CONCURRENCY_PER_CHAIN"],
    internalConsolidationFeeTier: env["INTERNAL_CONSOLIDATION_FEE_TIER"],
    consolidationDustGasMultiplier: env["CONSOLIDATION_DUST_GAS_MULTIPLIER"],
    consolidationTopUpCushionPercent: env["CONSOLIDATION_TOPUP_CUSHION_PERCENT"],
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
