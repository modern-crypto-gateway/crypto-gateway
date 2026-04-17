import type { CacheStore } from "./ports/cache.port.ts";
import type { ChainAdapter } from "./ports/chain.port.ts";
import type { DbAdapter } from "./ports/db.port.ts";
import type { DetectionStrategy } from "./ports/detection.port.ts";
import type { JobRunner } from "./ports/jobs.port.ts";
import type { Logger } from "./ports/logger.port.ts";
import type { PriceOracle } from "./ports/price-oracle.port.ts";
import type { RateLimiter } from "./ports/rate-limit.port.ts";
import type { ChainFamily } from "./types/chain.js";
import type { SecretsCipher } from "./ports/secrets-cipher.port.ts";
import type { SecretsProvider } from "./ports/secrets.port.ts";
import type { SignerStore } from "./ports/signer-store.port.ts";
import type { WebhookDispatcher } from "./ports/webhook-delivery.port.ts";
import type { WebhookDeliveryStore } from "./ports/webhook-delivery-store.port.ts";
import type { EventBus } from "./events/event-bus.port.ts";

// The full set of injected ports that domain services and adapters receive.
// Entrypoints construct a concrete AppDeps using adapters for the current runtime,
// then pass it to `buildApp(deps)` to produce a runtime-agnostic app.
//
// Every field is a port interface — never a concrete class. That is the whole
// point: swapping D1 for libSQL is changing one line in one entrypoint.
export interface AppDeps {
  readonly db: DbAdapter;
  readonly cache: CacheStore;
  readonly jobs: JobRunner;
  readonly secrets: SecretsProvider;
  // AES-GCM encrypt/decrypt for secrets-at-rest (merchant webhook HMAC secrets,
  // Alchemy signing keys). Every call site that persists or reads such a secret
  // goes through this port — storing plaintext is a layering violation.
  readonly secretsCipher: SecretsCipher;
  readonly signerStore: SignerStore;
  readonly priceOracle: PriceOracle;
  readonly webhookDispatcher: WebhookDispatcher;
  // Outbox/dead-letter store for merchant webhooks. Every composed webhook is
  // persisted here before dispatch; the scheduled-jobs sweeper retries any
  // 'pending' row past its next_attempt_at. See webhook-subscriber.ts.
  readonly webhookDeliveryStore: WebhookDeliveryStore;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly rateLimiter: RateLimiter;
  readonly rateLimits: RateLimitConfig;

  // Registered chain adapters. The domain resolves chainId -> adapter via
  // `findChainAdapter(deps, chainId)`; the array is open so Phase 2 can boot
  // with a single dev adapter and Phase 3+ adds EVM/Tron/Solana.
  readonly chains: readonly ChainAdapter[];

  // Per-chain DetectionStrategy. A chain with no entry here simply isn't
  // polled — pushed-only deployments (Alchemy Notify) leave this empty.
  readonly detectionStrategies: Readonly<Record<number, DetectionStrategy>>;

  // Push-based detection strategies, keyed by provider name. The corresponding
  // webhook ingest route is mounted only when the entry is present. Keys:
  //   - "alchemy-notify"   : Alchemy ADDRESS_ACTIVITY webhooks
  //   - "helius"           : Helius Solana webhooks (future)
  // Signing keys are stored per-webhook in the DB (`alchemy_webhook_registry`,
  // encrypted via `secretsCipher`) so multi-chain deployments work correctly.
  // Populated by bootstrap or the manual-register admin endpoint.
  readonly pushStrategies: Readonly<Record<string, DetectionStrategy>>;

  // Clock indirection so domain code is deterministic under test
  // (mock clock) and portable (no `Date.now()` leaks in services).
  readonly clock: { now(): Date };

  // Optional Alchemy sync surface. Populated only when ALCHEMY_NOTIFY_TOKEN
  // is set; the scheduled-jobs sweep invokes `syncAddresses` if present.
  // The function is pre-bound to the rest of deps — core/domain never sees
  // an AlchemyAdminClient directly.
  readonly alchemy?: {
    syncAddresses: () => Promise<unknown>;
  };

  // Per-family list of chainIds to subscribe on when a new pool address is
  // created. Consumed by `registerAlchemySubscriptionTracker`. The entrypoint
  // derives this from its Alchemy chain configuration (ALCHEMY_CHAINS env).
  // Absent for deployments without Alchemy — the tracker then enqueues
  // nothing (correctly, since there's nowhere to sync it to).
  readonly alchemySubscribableChainsByFamily?: Readonly<Partial<Record<ChainFamily, readonly number[]>>>;

  // Pre-loaded migration set. Populated on runtimes with filesystem access
  // (Node/Deno read the /migrations directory at boot) so the /admin/migrate
  // endpoint can re-apply them on demand. Absent on Workers/Vercel-Edge,
  // where migrations ship via `wrangler d1 migrations apply` / the Turso
  // migration CLI — the endpoint returns 501 when this field is missing.
  readonly migrations?: readonly MigrationEntry[];

  // Per-chain confirmation-threshold overrides. Takes precedence over the
  // shipped `DEFAULT_CONFIRMATION_THRESHOLDS` — populated from the
  // FINALITY_OVERRIDES env var (e.g. "1:20,137:64"). Empty / undefined means
  // fall back to the defaults.
  readonly confirmationThresholds?: Readonly<Record<number, number>>;
}

// Mirrors `adapters/db/migration-runner.ts Migration` — duplicated here so
// core/ doesn't import from adapter/. The runner references this shape too.
export interface MigrationEntry {
  readonly id: string;
  readonly sql: string;
}

// Per-surface rate-limit caps. Populated from AppConfig by the entrypoint so
// ops can tune without a redeploy. Middlewares pull from deps.rateLimits.
export interface RateLimitConfig {
  // Per-merchant cap on /api/v1/* (invoices + payouts).
  merchantPerMinute: number;
  // Per-IP cap on the public checkout endpoint.
  checkoutPerMinute: number;
  // Per-IP cap on the webhook ingest endpoints (Alchemy, etc.).
  webhookIngestPerMinute: number;
  // Per-IP cap on /admin/*. Admin routes are protected by ADMIN_KEY but an
  // attacker with a leaked/guessed key (or a misbehaving operator tool)
  // should still hit a throttle before exhausting D1/libsql write capacity.
  // Bucketed by client IP so one compromised key from one box does not
  // starve another operator's legitimate tooling.
  adminPerMinute: number;
  // Headers consulted (in order) by `getClientIp`. Anything not in this list
  // is ignored — an attacker can't spoof their rate-limit bucket key by
  // sending unsolicited X-Forwarded-For. Empty list = bucket all under
  // "anonymous". Defaults to ["cf-connecting-ip"] from config.
  readonly trustedIpHeaders: readonly string[];
}
