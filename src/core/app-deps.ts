import type { CacheStore } from "./ports/cache.port.ts";
import type { ChainAdapter } from "./ports/chain.port.ts";
import type { DbAdapter } from "./ports/db.port.ts";
import type { DetectionStrategy } from "./ports/detection.port.ts";
import type { JobRunner } from "./ports/jobs.port.ts";
import type { Logger } from "./ports/logger.port.ts";
import type { PriceOracle } from "./ports/price-oracle.port.ts";
import type { RateLimiter } from "./ports/rate-limit.port.ts";
import type { SecretsCipher } from "./ports/secrets-cipher.port.ts";
import type { SecretsProvider } from "./ports/secrets.port.ts";
import type { SignerStore } from "./ports/signer-store.port.ts";
import type { WebhookDispatcher } from "./ports/webhook-delivery.port.ts";
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
  //   - "helius"           : Helius Solana webhooks (Phase 7)
  // The signing key for each provider is read from SecretsProvider at request
  // time (ALCHEMY_NOTIFY_SIGNING_KEY, HELIUS_WEBHOOK_SECRET, ...).
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
}

// Per-surface rate-limit caps. Populated from AppConfig by the entrypoint so
// ops can tune without a redeploy. Middlewares pull from deps.rateLimits.
export interface RateLimitConfig {
  // Per-merchant cap on /api/v1/* (orders + payouts).
  merchantPerMinute: number;
  // Per-IP cap on the public checkout endpoint.
  checkoutPerMinute: number;
  // Per-IP cap on the webhook ingest endpoints (Alchemy, etc.).
  webhookIngestPerMinute: number;
}
