import { Hono } from "hono";
import { and, asc, desc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../../core/app-deps.js";
import {
  computeBalanceSnapshot,
  computeSpendable,
  type BalanceSnapshot
} from "../../core/domain/balance-snapshot.service.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import { isTronChainAdapter, TRON_MAINNET_CHAIN_ID } from "../../adapters/chains/tron/tron-chain.adapter.js";
import type { TronResourceKind } from "../../adapters/chains/tron/tron-rpc.js";
import { getStats as getPoolStats, initializePool } from "../../core/domain/pool.service.js";
import {
  ingestDetectedTransfer,
  recomputeInvoiceFromTransactions
} from "../../core/domain/payment.service.js";
import { confirmationThreshold } from "../../core/domain/payment-config.js";
import { ChainFamilySchema, type Address, type ChainFamily, type ChainId } from "../../core/types/chain.js";
import { CHAIN_REGISTRY, chainEntry, chainSlug } from "../../core/types/chain-registry.js";
import { TOKEN_REGISTRY } from "../../core/types/token-registry.js";
import type { TokenSymbol } from "../../core/types/token.js";
import { sha256Hex, bytesToHex, getRandomValues } from "../../adapters/crypto/subtle.js";
import { parseAlchemyChainsEnv } from "../../adapters/chains/evm/alchemy-rpc.js";
import { ALCHEMY_FAMILY_BY_CHAIN_ID } from "../../adapters/detection/alchemy-network.js";
import {
  alchemyAdminClient,
  type AlchemyAdminClient
} from "../../adapters/detection/alchemy-admin-client.js";
import { bootstrapAlchemyWebhooks } from "../../adapters/detection/bootstrap-alchemy-webhooks.js";
import { dbAlchemyRegistryStore } from "../../adapters/detection/alchemy-registry-store.js";
import { readAlchemyNotifyToken } from "../../adapters/detection/alchemy-token.js";
import { assertWebhookUrlSafe } from "../../core/domain/url-safety.js";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { addressPool, alchemyWebhookRegistry, invoices, merchants, payoutReservations, transactions } from "../../db/schema.js";
import { renderError } from "../middleware/error-handler.js";
import { adminAuth } from "../middleware/admin-auth.js";
import { getClientIp, rateLimit } from "../middleware/rate-limit.js";

// Operator-only surface. All routes require the shared admin key; the rest of
// the gateway authenticates merchants via their own API key. Keep this
// intentionally narrow — every endpoint here is a sharp edge.

// Maximum cooldown an operator can configure: 7 days. Long enough to cover
// any realistic late-payment window for a long-tail customer; short enough
// to bound how long an address can be parked from the pool's perspective.
const MAX_ADDRESS_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

const CreateMerchantSchema = z.object({
  name: z.string().min(1).max(128),
  webhookUrl: z.string().url().optional(),
  // If present, a 64-hex-char plaintext signing secret for outbound webhooks.
  // Omit to generate a fresh one; the plaintext is returned once in the response.
  webhookSecret: z.string().length(64).regex(/^[0-9a-f]+$/).optional(),
  // Default invoice payment tolerance in basis points. 1 bp = 0.01%.
  //   under: paid_usd ≥ amount_usd × (1 − under/10_000) closes as confirmed
  //   over:  paid_usd ≤ amount_usd × (1 + over /10_000) closes as confirmed
  // Capped at 2000 bps (20%); omit either to default to 0 (strict).
  paymentToleranceUnderBps: z.number().int().min(0).max(2000).optional(),
  paymentToleranceOverBps: z.number().int().min(0).max(2000).optional(),
  // Address-pool cooldown in seconds. After an invoice reaches a terminal
  // state, the pool address it held cannot be re-allocated to a different
  // invoice for this many seconds. Late payments arriving during the
  // cooldown still credit the original invoice via the orphan + admin-
  // attribute path. 0 (default) preserves legacy immediate-reuse behavior.
  addressCooldownSeconds: z.number().int().min(0).max(MAX_ADDRESS_COOLDOWN_SECONDS).optional()
});

const UpdateMerchantSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    webhookUrl: z.string().url().optional(),
    paymentToleranceUnderBps: z.number().int().min(0).max(2000).optional(),
    paymentToleranceOverBps: z.number().int().min(0).max(2000).optional(),
    addressCooldownSeconds: z.number().int().min(0).max(MAX_ADDRESS_COOLDOWN_SECONDS).optional()
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "PATCH body must contain at least one updatable field"
  });


// Bootstrap input. Every field optional — falls back to env / defaults so the
// simplest possible call is `POST /admin/bootstrap/alchemy-webhooks {}`.
//
// The webhook URL is intentionally NOT accepted in the body: it is derived
// from `GATEWAY_PUBLIC_URL` env (base origin) + the provider's canonical
// path (`/webhooks/alchemy`). An attacker with a leaked ADMIN_KEY would
// otherwise be able to point Alchemy's webhook traffic at an arbitrary host
// (leaking transfer patterns and burning through the 50k-address cap).
// Operators who need to target a different URL should change the env and
// redeploy, not call the API with a different body.
const BootstrapAlchemyWebhooksSchema = z.object({
  // Narrow the chain set. Defaults to ALCHEMY_CHAINS env, then the mainnet list.
  chainIds: z.array(z.number().int().positive()).optional(),
  // Per-chain initial address to seed the webhook with. Alchemy requires at
  // least one address at creation; leave empty to use the zero-address placeholder.
  seedAddressByChainId: z.record(z.string(), z.string()).optional()
});

// Manual-register input. Used when an operator created a webhook through the
// Alchemy dashboard UI (not via our bootstrap) and needs to push the
// returned signing key into our registry so the ingest route can verify
// inbound HMACs. Each field comes directly from Alchemy's create-webhook
// response.
const RegisterSigningKeySchema = z.object({
  chainId: z.number().int().positive(),
  webhookId: z.string().min(1).max(128),
  signingKey: z.string().min(1).max(256),
  // Must match GATEWAY_PUBLIC_URL/webhooks/alchemy in practice. Stored for
  // operator visibility (registry list endpoints, debugging).
  webhookUrl: z.string().url()
});

const AttributeOrphanSchema = z.object({
  invoiceId: z.string().uuid()
});

// Free-text reason capped at 512 chars — enough for "customer refund issued
// out-of-band, see ticket #123" without letting the admin queue become a
// log-dump target.
const DismissOrphanSchema = z.object({
  reason: z.string().min(1).max(512)
});

// Audit a single address against the chain: re-runs the scan, diffs against
// transactions already stored, and ingests the missing rows through the
// normal ingest path (so orphan / cooldown rules apply identically).
// sinceMs defaults to 30 days back — generous enough for operator forensic
// work; the adapter still clamps to its own per-chain max scan window.
const AuditAddressSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string().min(1).max(128),
  sinceMs: z.number().int().min(0).optional()
});

// Router options allow tests to inject a fake Alchemy admin client without
// spinning up an HTTP mock. Production constructs the client from env inside
// the handler.
export interface AdminRouterOptions {
  alchemyAdminClientFactory?: (authToken: string) => AlchemyAdminClient;
}

export function adminRouter(deps: AppDeps, opts: AdminRouterOptions = {}): Hono {
  const app = new Hono();
  // Rate-limit BEFORE auth: a caller hammering the surface with wrong keys
  // shouldn't be able to exhaust Turso writes or crowd out a legitimate operator.
  // Bucketed by client IP (trusted headers only — same rule as the rest of
  // the gateway) so the limit is per box, not per connection.
  app.use(
    "*",
    rateLimit(deps, {
      scope: "admin",
      keyFn: (c) => getClientIp(c, deps.rateLimits.trustedIpHeaders),
      limit: deps.rateLimits.adminPerMinute,
      windowSeconds: 60
    })
  );
  app.use("*", adminAuth(deps));
  const clientFactory =
    opts.alchemyAdminClientFactory ?? ((authToken) => alchemyAdminClient({ authToken }));

  app.post("/merchants", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = CreateMerchantSchema.parse(body);

      // SSRF guard: reject webhook URLs pointing at private/loopback/metadata
      // hosts before we ever accept the merchant. `allowHttp` is on in
      // development so local-dev merchants can target http://localhost
      // webhook receivers during testing — strict https/external-only in
      // every other environment.
      if (parsed.webhookUrl !== undefined) {
        const envName = deps.secrets.getOptional("NODE_ENV");
        const allowHttp = envName === "development" || envName === "test";
        const safety = assertWebhookUrlSafe(parsed.webhookUrl, { allowHttp });
        if (!safety.ok) {
          return c.json(
            {
              error: {
                code: "INVALID_WEBHOOK_URL",
                message: `Webhook URL rejected: ${safety.detail ?? safety.reason}`
              }
            },
            400
          );
        }
      }

      const apiKey = `sk_${bytesToRandomHex(32)}`;
      const apiKeyHash = await sha256Hex(apiKey);
      const webhookSecret = parsed.webhookSecret ?? bytesToRandomHex(32);
      const id = globalThis.crypto.randomUUID();
      const now = deps.clock.now().getTime();

      // HMAC signing requires the plaintext secret, so hashing isn't an option.
      // We encrypt at rest via secretsCipher (AES-GCM, master key in
      // SECRETS_ENCRYPTION_KEY) and decrypt per dispatch in webhook-subscriber.
      const webhookSecretCiphertext = parsed.webhookUrl
        ? await deps.secretsCipher.encrypt(webhookSecret)
        : null;

      const paymentToleranceUnderBps = parsed.paymentToleranceUnderBps ?? 0;
      const paymentToleranceOverBps = parsed.paymentToleranceOverBps ?? 0;
      const addressCooldownSeconds = parsed.addressCooldownSeconds ?? 0;
      await deps.db.insert(merchants).values({
        id,
        name: parsed.name,
        apiKeyHash,
        webhookUrl: parsed.webhookUrl ?? null,
        webhookSecretCiphertext,
        active: 1,
        paymentToleranceUnderBps,
        paymentToleranceOverBps,
        addressCooldownSeconds,
        createdAt: now,
        updatedAt: now
      });

      return c.json(
        {
          merchant: {
            id,
            name: parsed.name,
            webhookUrl: parsed.webhookUrl ?? null,
            active: true,
            paymentToleranceUnderBps,
            paymentToleranceOverBps,
            addressCooldownSeconds,
            createdAt: new Date(now).toISOString()
          },
          // Plaintext API key returned once — never recoverable after this response.
          // Plaintext webhook secret is returned only when a webhook URL is set.
          apiKey,
          ...(parsed.webhookUrl ? { webhookSecret } : {})
        },
        201
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // PATCH a merchant. Mutable fields:
  //   - name, webhookUrl, paymentToleranceUnder/OverBps, addressCooldownSeconds
  // NOT mutable here:
  //   - `active` → use /deactivate + /activate
  //   - `apiKey` → use /rotate-key
  //   - `webhookSecret` → use /rotate-webhook-secret (coordinated rotation, plaintext returned once)
  //
  // Special case: a merchant created without a webhookUrl has no
  // webhook_secret_ciphertext. If this PATCH sets the URL for the first time
  // we mint a secret, store its ciphertext, and return the plaintext in the
  // response (same one-shot contract as POST /admin/merchants). Changing an
  // already-set URL does NOT rotate the secret — outbound signed-HMAC
  // contracts stay stable; the merchant just receives on a different URL.
  app.patch("/merchants/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = UpdateMerchantSchema.parse(body);

      if (parsed.webhookUrl !== undefined) {
        const envName = deps.secrets.getOptional("NODE_ENV");
        const allowHttp = envName === "development" || envName === "test";
        const safety = assertWebhookUrlSafe(parsed.webhookUrl, { allowHttp });
        if (!safety.ok) {
          return c.json(
            {
              error: {
                code: "INVALID_WEBHOOK_URL",
                message: `Webhook URL rejected: ${safety.detail ?? safety.reason}`
              }
            },
            400
          );
        }
      }

      // We need to know whether the merchant already has a webhook secret
      // before deciding whether to mint one on a first-time URL set.
      const [existing] = await deps.db
        .select({
          webhookUrl: merchants.webhookUrl,
          webhookSecretCiphertext: merchants.webhookSecretCiphertext
        })
        .from(merchants)
        .where(eq(merchants.id, id))
        .limit(1);
      if (!existing) {
        return c.json(
          { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
          404
        );
      }

      const now = deps.clock.now().getTime();
      const patch: Partial<{
        name: string;
        webhookUrl: string;
        webhookSecretCiphertext: string;
        paymentToleranceUnderBps: number;
        paymentToleranceOverBps: number;
        addressCooldownSeconds: number;
        updatedAt: number;
      }> = { updatedAt: now };
      if (parsed.name !== undefined) patch.name = parsed.name;
      if (parsed.paymentToleranceUnderBps !== undefined) {
        patch.paymentToleranceUnderBps = parsed.paymentToleranceUnderBps;
      }
      if (parsed.paymentToleranceOverBps !== undefined) {
        patch.paymentToleranceOverBps = parsed.paymentToleranceOverBps;
      }
      if (parsed.addressCooldownSeconds !== undefined) {
        patch.addressCooldownSeconds = parsed.addressCooldownSeconds;
      }

      let mintedWebhookSecret: string | null = null;
      if (parsed.webhookUrl !== undefined) {
        patch.webhookUrl = parsed.webhookUrl;
        if (existing.webhookSecretCiphertext === null) {
          mintedWebhookSecret = bytesToRandomHex(32);
          patch.webhookSecretCiphertext = await deps.secretsCipher.encrypt(mintedWebhookSecret);
        }
      }

      const [row] = await deps.db
        .update(merchants)
        .set(patch)
        .where(eq(merchants.id, id))
        .returning();
      if (!row) {
        return c.json(
          { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
          404
        );
      }
      return c.json(
        {
          merchant: {
            id: row.id,
            name: row.name,
            webhookUrl: row.webhookUrl,
            active: row.active === 1,
            paymentToleranceUnderBps: row.paymentToleranceUnderBps,
            paymentToleranceOverBps: row.paymentToleranceOverBps,
            addressCooldownSeconds: row.addressCooldownSeconds,
            updatedAt: new Date(row.updatedAt).toISOString()
          },
          ...(mintedWebhookSecret !== null ? { webhookSecret: mintedWebhookSecret } : {})
        },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // List merchants. Paginated; supports ?active=true|false to filter out
  // deactivated rows for live-dashboard views. Never returns api_key_hash or
  // webhook_secret_ciphertext — both are secrets-adjacent and not useful to
  // display. Operators who need to revoke a leaked key use the rotate-key
  // endpoint; the old hash becomes invalid automatically.
  app.get("/merchants", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
    const activeParam = c.req.query("active");
    const conds: SQL[] = [];
    if (activeParam === "true") conds.push(eq(merchants.active, 1));
    else if (activeParam === "false") conds.push(eq(merchants.active, 0));
    else if (activeParam !== undefined) {
      return c.json(
        { error: { code: "BAD_ACTIVE", message: "active must be 'true' or 'false'" } },
        400
      );
    }
    const base = deps.db
      .select({
        id: merchants.id,
        name: merchants.name,
        webhookUrl: merchants.webhookUrl,
        active: merchants.active,
        paymentToleranceUnderBps: merchants.paymentToleranceUnderBps,
        paymentToleranceOverBps: merchants.paymentToleranceOverBps,
        addressCooldownSeconds: merchants.addressCooldownSeconds,
        createdAt: merchants.createdAt,
        updatedAt: merchants.updatedAt
      })
      .from(merchants)
      .orderBy(desc(merchants.createdAt))
      .limit(limit)
      .offset(offset);
    const rows = conds.length === 0 ? await base : await base.where(and(...conds));
    return c.json(
      {
        merchants: rows.map((r) => ({
          id: r.id,
          name: r.name,
          webhookUrl: r.webhookUrl,
          active: r.active === 1,
          paymentToleranceUnderBps: r.paymentToleranceUnderBps,
          paymentToleranceOverBps: r.paymentToleranceOverBps,
          addressCooldownSeconds: r.addressCooldownSeconds,
          createdAt: new Date(r.createdAt).toISOString(),
          updatedAt: new Date(r.updatedAt).toISOString()
        })),
        limit,
        offset
      },
      200
    );
  });

  app.get("/merchants/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await deps.db
      .select({
        id: merchants.id,
        name: merchants.name,
        webhookUrl: merchants.webhookUrl,
        active: merchants.active,
        paymentToleranceUnderBps: merchants.paymentToleranceUnderBps,
        paymentToleranceOverBps: merchants.paymentToleranceOverBps,
        addressCooldownSeconds: merchants.addressCooldownSeconds,
        createdAt: merchants.createdAt,
        updatedAt: merchants.updatedAt
      })
      .from(merchants)
      .where(eq(merchants.id, id))
      .limit(1);
    if (!row) {
      return c.json(
        { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
        404
      );
    }
    return c.json(
      {
        merchant: {
          id: row.id,
          name: row.name,
          webhookUrl: row.webhookUrl,
          active: row.active === 1,
          paymentToleranceUnderBps: row.paymentToleranceUnderBps,
          paymentToleranceOverBps: row.paymentToleranceOverBps,
          addressCooldownSeconds: row.addressCooldownSeconds,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString()
        }
      },
      200
    );
  });

  // Rotate a merchant's API key. Generates a fresh `sk_<hex>` plaintext,
  // replaces the stored hash in one UPDATE, and returns the plaintext in the
  // response body — exactly like the create flow, this is the one and only
  // chance to capture it. The prior key stops working immediately on the
  // next request (auth middleware hashes inbound tokens and looks them up
  // by hash). Webhook URL / secret are intentionally left alone: rotating
  // those mid-flight would orphan pending outbox rows signed under the old
  // secret (see PATCH handler comment).
  app.post("/merchants/:id/rotate-key", async (c) => {
    const id = c.req.param("id");
    try {
      const apiKey = `sk_${bytesToRandomHex(32)}`;
      const apiKeyHash = await sha256Hex(apiKey);
      const now = deps.clock.now().getTime();
      const [row] = await deps.db
        .update(merchants)
        .set({ apiKeyHash, updatedAt: now })
        .where(eq(merchants.id, id))
        .returning();
      if (!row) {
        return c.json(
          { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
          404
        );
      }
      deps.logger.info("admin rotated merchant api key", { merchantId: id });
      return c.json(
        {
          merchant: {
            id: row.id,
            name: row.name,
            active: row.active === 1,
            updatedAt: new Date(row.updatedAt).toISOString()
          },
          apiKey
        },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Rotate a merchant's webhook HMAC signing secret. Generates a fresh 32-byte
  // hex plaintext, encrypts at rest via `secretsCipher`, returns the plaintext
  // once so the operator can hand it to the merchant for their verifier.
  //
  // Coordinated-rotation caveat: pending outbox rows (status='pending') that
  // were enqueued BEFORE this call will be dispatched signed with the NEW
  // secret because the dispatcher reads merchant state at send time. The
  // merchant's verifier must already hold the new secret when those deliveries
  // arrive, or they'll 401 and end up in dead-letter. Sequence it:
  //   1) announce the rotation window to the merchant,
  //   2) call this endpoint,
  //   3) deliver the plaintext through a secure channel,
  //   4) merchant updates their HMAC secret.
  // Any in-flight retries that span steps 2-4 will fail HMAC and go to
  // webhook_deliveries.status='dead'; replay via /admin/webhook-deliveries/:id/replay
  // after the merchant confirms the new secret is live.
  //
  // Requires the merchant to have a webhookUrl configured — rotating a secret
  // for a merchant with no receiver is meaningless.
  app.post("/merchants/:id/rotate-webhook-secret", async (c) => {
    const id = c.req.param("id");
    try {
      const [existing] = await deps.db
        .select({ webhookUrl: merchants.webhookUrl })
        .from(merchants)
        .where(eq(merchants.id, id))
        .limit(1);
      if (!existing) {
        return c.json(
          { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
          404
        );
      }
      if (existing.webhookUrl === null) {
        return c.json(
          {
            error: {
              code: "NO_WEBHOOK_URL",
              message:
                "Merchant has no webhookUrl configured. PATCH /admin/merchants/:id with a webhookUrl first — the first-time set returns a freshly minted plaintext secret."
            }
          },
          400
        );
      }
      const webhookSecret = bytesToRandomHex(32);
      const webhookSecretCiphertext = await deps.secretsCipher.encrypt(webhookSecret);
      const now = deps.clock.now().getTime();
      const [row] = await deps.db
        .update(merchants)
        .set({ webhookSecretCiphertext, updatedAt: now })
        .where(eq(merchants.id, id))
        .returning();
      if (!row) {
        return c.json(
          { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
          404
        );
      }
      deps.logger.info("admin rotated merchant webhook secret", { merchantId: id });
      return c.json(
        {
          merchant: {
            id: row.id,
            name: row.name,
            webhookUrl: row.webhookUrl,
            active: row.active === 1,
            updatedAt: new Date(row.updatedAt).toISOString()
          },
          webhookSecret
        },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Deactivate / reactivate a merchant. Sets the `active` column; idempotent
  // (deactivating an already-inactive merchant returns 200 with active=false).
  // Deactivation does NOT invalidate the API key hash — reactivation restores
  // the same credential. Use rotate-key first if the deactivation is
  // prompted by a credential leak.
  app.post("/merchants/:id/deactivate", async (c) => {
    const id = c.req.param("id");
    const now = deps.clock.now().getTime();
    const [row] = await deps.db
      .update(merchants)
      .set({ active: 0, updatedAt: now })
      .where(eq(merchants.id, id))
      .returning();
    if (!row) {
      return c.json(
        { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
        404
      );
    }
    deps.logger.info("admin deactivated merchant", { merchantId: id });
    return c.json(
      {
        merchant: {
          id: row.id,
          name: row.name,
          active: row.active === 1,
          updatedAt: new Date(row.updatedAt).toISOString()
        }
      },
      200
    );
  });

  app.post("/merchants/:id/activate", async (c) => {
    const id = c.req.param("id");
    const now = deps.clock.now().getTime();
    const [row] = await deps.db
      .update(merchants)
      .set({ active: 1, updatedAt: now })
      .where(eq(merchants.id, id))
      .returning();
    if (!row) {
      return c.json(
        { error: { code: "MERCHANT_NOT_FOUND", message: `Merchant not found: ${id}` } },
        404
      );
    }
    deps.logger.info("admin activated merchant", { merchantId: id });
    return c.json(
      {
        merchant: {
          id: row.id,
          name: row.name,
          active: row.active === 1,
          updatedAt: new Date(row.updatedAt).toISOString()
        }
      },
      200
    );
  });


  app.post("/bootstrap/alchemy-webhooks", async (c) => {
    const authToken = readAlchemyNotifyToken(deps.secrets, deps.logger);
    if (authToken === undefined) {
      return c.json(
        {
          error: {
            code: "NOT_CONFIGURED",
            message:
              "ALCHEMY_NOTIFY_TOKEN is not set. Get it from the top of https://dashboard.alchemy.com/apps/latest/webhooks (labelled 'Auth Token') — NOT the JSON-RPC API key."
          }
        },
        400
      );
    }

    // Body is optional (every field has a default) but if the operator DID
    // send something, it must be valid JSON — silently treating a malformed
    // POST as `{}` would hide typos in `chainIds` / `seedAddressByChainId`
    // and ship the defaults without warning. Empty body is permitted and
    // parsed as `{}`; malformed JSON returns BAD_JSON like every other admin
    // endpoint.
    const rawBody = await c.req.text();
    let parsedBody: unknown = {};
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return c.json({ error: { code: "BAD_JSON" } }, 400);
      }
    }
    let parsed: z.infer<typeof BootstrapAlchemyWebhooksSchema>;
    try {
      parsed = BootstrapAlchemyWebhooksSchema.parse(parsedBody);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }

    // Base URL of this gateway (no trailing path). Bootstrap appends the
    // per-provider path (`/webhooks/alchemy`) so operators only have to set
    // one env var that applies to every current and future webhook provider.
    const publicBaseUrl = deps.secrets.getOptional("GATEWAY_PUBLIC_URL");
    if (publicBaseUrl === undefined) {
      return c.json(
        {
          error: {
            code: "MISSING_GATEWAY_PUBLIC_URL",
            message:
              "Set GATEWAY_PUBLIC_URL env to this gateway's public origin (e.g. https://gateway.example.com)."
          }
        },
        400
      );
    }

    const webhookUrl = publicBaseUrl.replace(/\/+$/, "") + "/webhooks/alchemy";

    const chainIds =
      parsed.chainIds ?? parseAlchemyChainsEnv(deps.secrets.getOptional("ALCHEMY_CHAINS"));

    const seedAddressByChainId: Record<number, string> = {};
    if (parsed.seedAddressByChainId !== undefined) {
      for (const [k, v] of Object.entries(parsed.seedAddressByChainId)) {
        const chainId = Number(k);
        if (Number.isFinite(chainId)) seedAddressByChainId[chainId] = v;
      }
    }

    try {
      const client = clientFactory(authToken);
      const registryStore = dbAlchemyRegistryStore(deps.db);
      const bootstrapArgs: Parameters<typeof bootstrapAlchemyWebhooks>[0] = {
        client,
        webhookUrl,
        chainIds,
        registryStore,
        secretsCipher: deps.secretsCipher,
        logger: deps.logger,
        now: () => deps.clock.now().getTime()
      };
      if (Object.keys(seedAddressByChainId).length > 0) {
        bootstrapArgs.seedAddressByChainId = seedAddressByChainId;
      }
      const results = await bootstrapAlchemyWebhooks(bootstrapArgs);

      // Surface any `created` row whose persistence failed — the operator
      // needs to manually paste that row into the registry or delete-and-
      // recreate. `persisted=true` rows need no action: the inbound ingest
      // route will resolve the signing key from the DB.
      //
      // Hard-fail the response with 500 if any row failed to persist, so
      // operators/CI notice the orphan in Alchemy rather than assuming a 2xx
      // means "all wired". The response body still carries the signingKey so
      // the operator can re-register via POST /alchemy-webhooks/signing-keys.
      const needsManualAction = results.filter(
        (r) => r.status === "created" && r.persisted === false
      );
      if (needsManualAction.length > 0) {
        deps.logger.error(
          "alchemy: webhook created but registry write failed; signingKey returned in response only",
          {
            chainIds: needsManualAction.map((r) => r.chainId),
            webhookIds: needsManualAction.map((r) => r.webhookId)
          }
        );
        return c.json(
          {
            error: {
              code: "BOOTSTRAP_PARTIAL_FAILURE",
              message:
                "One or more webhooks were created in Alchemy but could not be persisted to the registry. Register each orphaned webhook's signingKey via POST /admin/alchemy-webhooks/signing-keys using the values in `results`."
            },
            results
          },
          500
        );
      }

      return c.json({ results }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Manually register an Alchemy webhook's signing key — for operators who
  // created the webhook through Alchemy's dashboard UI instead of our
  // bootstrap endpoint. The signing key is encrypted via `secretsCipher`
  // before it hits the registry, same path bootstrap uses. Re-running with
  // the same chainId overwrites (intended: rotation after a dashboard
  // delete+recreate produces a new key).
  // Discovery surface for the admin dashboard: which chains the gateway has
  // wired vs. which it merely recognises in the static registry, with
  // bootstrap-readiness flags inlined so the dashboard renders the picker in
  // a single round-trip.
  //
  //   wired:             ChainAdapter for this chainId is loaded in deps.chains
  //   webhooksSupported: chainId is in ALCHEMY_FAMILY_BY_CHAIN_ID (EVM + Solana
  //                      networks Alchemy serves). False for Tron — it uses RPC
  //                      polling, has no webhook concept. Frontend should hide
  //                      the "register webhook" CTA when this is false.
  //   alchemyConfigured: operator's ALCHEMY_CHAINS env actually includes this
  //                      chainId (i.e. deps.alchemySubscribableChainsByFamily
  //                      lists it). Independent of webhook registration.
  //   webhooks:          row exists in alchemy_webhook_registry (= POST /admin/bootstrap/alchemy-webhooks ran).
  //                      Only meaningful when webhooksSupported=true.
  //   feeWallets:        ≥1 ACTIVE fee wallet for this chain (deactivated wallets don't count toward "ready")
  //   detection:         "alchemy" if webhooksSupported, else "rpc-poll" — pure
  //                      derived field, surfaced so the frontend doesn't have
  //                      to know our chain-family taxonomy.
  //
  // bootstrapReady drops the webhook requirement when webhooksSupported is
  // false, so RPC-poll chains (Tron) can still report ready when wired+funded.
  //
  // The dev chain (chainId 999) is excluded — it's an integration-test fixture,
  // not something operators should ever bootstrap. Listing it would clutter
  // the picker and let an operator accidentally try to wire a real Alchemy
  // webhook to a synthetic chainId.
  //
  // Tokens come from the static TOKEN_REGISTRY — same for every operator,
  // never includes per-merchant overrides.
  app.get("/chains", async (c) => {
    const familyParam = c.req.query("family");
    const wiredParam = c.req.query("wired");

    if (familyParam !== undefined && !ChainFamilySchema.safeParse(familyParam).success) {
      return c.json(
        { error: { code: "BAD_FAMILY", message: "family must be one of: evm, tron, solana" } },
        400
      );
    }

    const wiredChainIds = new Set<number>();
    for (const adapter of deps.chains) {
      for (const id of adapter.supportedChainIds) wiredChainIds.add(id as number);
    }

    // Two small SELECTs to derive the readiness flags. Both return the
    // distinct chainIds we care about; building Sets keeps the per-row check
    // O(1). Cheaper than left-joining inside the registry walk and easy to
    // understand at a glance.
    const webhookRows = await deps.db
      .select({ chainId: alchemyWebhookRegistry.chainId })
      .from(alchemyWebhookRegistry);
    const webhookChainIds = new Set(webhookRows.map((r) => r.chainId));

    // Pool addresses are family-scoped; per-chain "has at least one source"
    // = "the family has at least one pool row AND the chain is wired". We
    // pre-compute the set of families with any pool address.
    const poolFamilyRows = await deps.db
      .selectDistinct({ family: addressPool.family })
      .from(addressPool);
    const poolFamilies = new Set(poolFamilyRows.map((r) => r.family));

    // Per-family alchemy subscription set, flattened so per-chainId lookups
    // are O(1). Empty when the entrypoint didn't supply Alchemy config.
    const alchemyConfiguredChainIds = new Set<number>();
    for (const ids of Object.values(deps.alchemySubscribableChainsByFamily ?? {})) {
      for (const id of ids ?? []) alchemyConfiguredChainIds.add(id);
    }

    type ChainOut = {
      chainId: number;
      slug: string;
      family: ChainFamily;
      displayName: string;
      wired: boolean;
      webhooksSupported: boolean;
      alchemyConfigured: boolean;
      webhooks: boolean;
      feeWallets: boolean;
      detection: "alchemy" | "rpc-poll";
      bootstrapReady: boolean;
      confirmationsRequired: number;
      tokens: Array<{
        symbol: string;
        decimals: number;
        isStable: boolean;
        displayName: string;
        contractAddress: string | null;
      }>;
    };

    // ChainIds excluded from the dashboard view entirely. 999 = dev chain
    // used only by integration tests; surfacing it would be operator-confusing.
    const HIDDEN_CHAIN_IDS = new Set<number>([999]);

    const out: ChainOut[] = [];

    // Walk the static registry first so the response order is stable
    // (registry order = response order). Wired chains that aren't in the
    // static registry are appended at the end — defensive: a wired adapter
    // without a registry entry is a config bug, but we still surface it so
    // operators can see what's actually loaded.
    const seen = new Set<number>();
    for (const entry of CHAIN_REGISTRY) {
      const id = entry.chainId as number;
      seen.add(id);
      if (HIDDEN_CHAIN_IDS.has(id)) continue;
      const wired = wiredChainIds.has(id);
      if (familyParam !== undefined && entry.family !== familyParam) continue;
      if (wiredParam === "true" && !wired) continue;
      if (wiredParam === "false" && wired) continue;
      const hasWebhook = webhookChainIds.has(id);
      // Per-chain "has at least one funded source" reduces to "the family has
// any pool address" — the picker treats every pool row as a candidate.
const hasFeeWallet = poolFamilies.has(
  (deps.chains.find((a) => a.supportedChainIds.includes(id as ChainId))?.family) ?? "evm"
);
      const webhooksSupported = ALCHEMY_FAMILY_BY_CHAIN_ID[id] !== undefined;
      const alchemyConfigured = alchemyConfiguredChainIds.has(id);
      out.push({
        chainId: id,
        slug: entry.slug,
        family: entry.family,
        displayName: entry.displayName,
        wired,
        webhooksSupported,
        alchemyConfigured,
        webhooks: hasWebhook,
        feeWallets: hasFeeWallet,
        detection: webhooksSupported ? "alchemy" : "rpc-poll",
        bootstrapReady: wired && (!webhooksSupported || hasWebhook) && hasFeeWallet,
        confirmationsRequired: confirmationThreshold(entry.chainId, deps.confirmationThresholds),
        tokens: TOKEN_REGISTRY.filter((t) => t.chainId === entry.chainId).map((t) => ({
          symbol: t.symbol as string,
          decimals: t.decimals,
          isStable: t.isStable,
          displayName: t.displayName,
          contractAddress: t.contractAddress
        }))
      });
    }
    // Wired-but-unregistered tail.
    for (const id of wiredChainIds) {
      if (seen.has(id)) continue;
      if (HIDDEN_CHAIN_IDS.has(id)) continue;
      const family = (deps.chains.find((a) => a.supportedChainIds.includes(id as ChainId))?.family) ?? "evm";
      if (familyParam !== undefined && family !== familyParam) continue;
      if (wiredParam === "false") continue;
      const hasWebhook = webhookChainIds.has(id);
      // Per-chain "has at least one funded source" reduces to "the family has
// any pool address" — the picker treats every pool row as a candidate.
const hasFeeWallet = poolFamilies.has(
  (deps.chains.find((a) => a.supportedChainIds.includes(id as ChainId))?.family) ?? "evm"
);
      const webhooksSupported = ALCHEMY_FAMILY_BY_CHAIN_ID[id] !== undefined;
      const alchemyConfigured = alchemyConfiguredChainIds.has(id);
      out.push({
        chainId: id,
        slug: chainSlug(id) ?? `chain-${id}`,
        family,
        displayName: chainEntry(id)?.displayName ?? `Chain ${id}`,
        wired: true,
        webhooksSupported,
        alchemyConfigured,
        webhooks: hasWebhook,
        feeWallets: hasFeeWallet,
        detection: webhooksSupported ? "alchemy" : "rpc-poll",
        bootstrapReady: (!webhooksSupported || hasWebhook) && hasFeeWallet,
        confirmationsRequired: confirmationThreshold(id, deps.confirmationThresholds),
        tokens: TOKEN_REGISTRY.filter((t) => t.chainId === id).map((t) => ({
          symbol: t.symbol as string,
          decimals: t.decimals,
          isStable: t.isStable,
          displayName: t.displayName,
          contractAddress: t.contractAddress
        }))
      });
    }

    return c.json({ chains: out });
  });

  // List Alchemy webhook registrations (one row per chain). The signing key
  // is encrypted at rest and is NEVER returned — operators who need to verify
  // a key should rotate via POST /alchemy-webhooks/signing-keys instead. This
  // endpoint is the dashboard's read of "what did /bootstrap/alchemy-webhooks
  // actually create"; the dashboard uses it to decide which chains still need
  // bootstrapping vs. which are already wired.
  app.get("/alchemy-webhooks", async (c) => {
    const chainIdParam = c.req.query("chainId");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100"), 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);

    const conds: SQL[] = [];
    if (chainIdParam !== undefined) {
      const n = Number(chainIdParam);
      if (!Number.isFinite(n)) {
        return c.json({ error: { code: "BAD_CHAIN_ID", message: "chainId must be a number" } }, 400);
      }
      conds.push(eq(alchemyWebhookRegistry.chainId, n));
    }

    const rows = await deps.db
      .select({
        chainId: alchemyWebhookRegistry.chainId,
        webhookId: alchemyWebhookRegistry.webhookId,
        webhookUrl: alchemyWebhookRegistry.webhookUrl,
        createdAt: alchemyWebhookRegistry.createdAt,
        updatedAt: alchemyWebhookRegistry.updatedAt
      })
      .from(alchemyWebhookRegistry)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(alchemyWebhookRegistry.chainId))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({
      webhooks: page.map((r) => ({
        chainId: r.chainId,
        chain: chainSlug(r.chainId),
        webhookId: r.webhookId,
        webhookUrl: r.webhookUrl,
        createdAt: new Date(r.createdAt).toISOString(),
        updatedAt: new Date(r.updatedAt).toISOString()
      })),
      limit,
      offset,
      hasMore
    });
  });

  app.post("/alchemy-webhooks/signing-keys", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = RegisterSigningKeySchema.parse(body);
      const ciphertext = await deps.secretsCipher.encrypt(parsed.signingKey);
      await dbAlchemyRegistryStore(deps.db).upsert({
        chainId: parsed.chainId,
        webhookId: parsed.webhookId,
        signingKeyCiphertext: ciphertext,
        webhookUrl: parsed.webhookUrl,
        now: deps.clock.now().getTime()
      });
      return c.json(
        {
          registered: {
            chainId: parsed.chainId,
            webhookId: parsed.webhookId,
            webhookUrl: parsed.webhookUrl
          }
        },
        201
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Seed (or top up) the address pool. Idempotent: families already at or
  // above `initialSize` are returned as 'already-sufficient' with zero
  // additions. Families without a wired chain adapter in deps.chains are
  // 'skipped-no-adapter'. The endpoint is safe to call repeatedly and is
  // also the recovery path when the pool exhausts in prod.
  app.post("/pool/initialize", async (c) => {
    // Same rule as /bootstrap/alchemy-webhooks: empty body is fine (every
    // field has a default), malformed JSON returns BAD_JSON so typos don't
    // silently fall through to defaults.
    const rawBody = await c.req.text();
    let parsedBody: unknown = {};
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return c.json({ error: { code: "BAD_JSON" } }, 400);
      }
    }
    try {
      const parsed = InitializePoolSchema.parse(parsedBody);
      const results = await initializePool(deps, parsed);
      return c.json({ results }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Per-family pool utilization snapshot. Operators watch this + an alert
  // on available-count under threshold to catch "address supply running
  // low" before POOL_EXHAUSTED fires on a live invoice-create.
  app.get("/pool/stats", async (c) => {
    const stats = await getPoolStats(deps);
    return c.json({ stats }, 200);
  });

  // Webhook delivery dead-letter surface. Operators list rows by status
  // (usually 'dead') and replay individual ones once they've coordinated a
  // fix with the merchant (TLS cert renewed, URL path changed, etc.).
  app.get("/webhook-deliveries", async (c) => {
    const statusParam = c.req.query("status") ?? "dead";
    if (statusParam !== "pending" && statusParam !== "delivered" && statusParam !== "dead") {
      return c.json(
        { error: { code: "BAD_STATUS", message: "status must be one of: pending, delivered, dead" } },
        400
      );
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
    const rows = await deps.webhookDeliveryStore.listByStatus({
      status: statusParam,
      limit,
      offset
    });
    return c.json({ deliveries: rows }, 200);
  });

  app.post("/webhook-deliveries/:id/replay", async (c) => {
    const id = c.req.param("id");
    const now = deps.clock.now().getTime();
    const { reset } = await deps.webhookDeliveryStore.resetForReplay({
      id,
      nextAttemptAt: now,
      now
    });
    if (!reset) {
      return c.json(
        {
          error: {
            code: "NOT_DEAD",
            message:
              "Delivery row not found, or not in 'dead' status. Only dead rows can be replayed — pending rows are already queued for the sweeper."
          }
        },
        404
      );
    }
    deps.logger.info("webhook delivery replay queued", { deliveryId: id });
    return c.json({ replayed: { id, nextAttemptAt: now } }, 200);
  });

  // Orphan transaction queue. An "orphan" is a confirmed/detected transfer
  // that landed on an address with no active invoice claim (and outside any
  // cooldown window). The ingest path writes these as `status='orphaned'`,
  // `invoice_id=NULL` so admins can either:
  //   - attribute the row to a specific invoice (re-points invoice_id, then
  //     recomputes the invoice with viaAdminOverride so even an expired /
  //     canceled invoice can flip to confirmed when the credit clears its
  //     bar), or
  //   - dismiss the row with a free-text reason (audit trail; the tx still
  //     exists, the partial index just hides it from the queue).
  //
  // The list query is backed by `idx_transactions_orphans_open`
  // (chain_id, detected_at) WHERE invoice_id IS NULL AND dismissed_at IS NULL.
  app.get("/orphan-transactions", async (c) => {
    const chainIdParam = c.req.query("chainId");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);

    const filters = [isNull(transactions.invoiceId), isNull(transactions.dismissedAt)];
    if (chainIdParam !== undefined) {
      const n = Number(chainIdParam);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json(
          { error: { code: "BAD_CHAIN_ID", message: "chainId must be a positive integer" } },
          400
        );
      }
      filters.push(eq(transactions.chainId, n));
    }

    const rows = await deps.db
      .select()
      .from(transactions)
      .where(and(...filters))
      .orderBy(desc(transactions.detectedAt), asc(transactions.id))
      .limit(limit)
      .offset(offset);

    return c.json(
      {
        orphans: rows.map((row) => ({
          id: row.id,
          chainId: row.chainId,
          txHash: row.txHash,
          logIndex: row.logIndex,
          fromAddress: row.fromAddress,
          toAddress: row.toAddress,
          token: row.token,
          amountRaw: row.amountRaw,
          amountUsd: row.amountUsd,
          usdRate: row.usdRate,
          blockNumber: row.blockNumber,
          confirmations: row.confirmations,
          status: row.status,
          detectedAt: new Date(row.detectedAt).toISOString()
        }))
      },
      200
    );
  });

  app.post("/orphan-transactions/:id/attribute", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = AttributeOrphanSchema.parse(body);
      const now = deps.clock.now().getTime();

      const [orphan] = await deps.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, id))
        .limit(1);
      if (!orphan) {
        return c.json(
          { error: { code: "ORPHAN_NOT_FOUND", message: `No transaction with id ${id}` } },
          404
        );
      }
      if (orphan.invoiceId !== null) {
        return c.json(
          {
            error: {
              code: "NOT_ORPHAN",
              message: "Transaction already attributed to an invoice; cannot re-attribute."
            }
          },
          409
        );
      }
      if (orphan.dismissedAt !== null) {
        return c.json(
          {
            error: {
              code: "ORPHAN_DISMISSED",
              message: "Transaction was previously dismissed; un-dismiss before attributing."
            }
          },
          409
        );
      }

      const [invoiceRow] = await deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, parsed.invoiceId))
        .limit(1);
      if (!invoiceRow) {
        return c.json(
          { error: { code: "INVOICE_NOT_FOUND", message: `No invoice with id ${parsed.invoiceId}` } },
          404
        );
      }

      // Promote orphan → detected/confirmed based on its existing confirmation
      // count vs the chain's threshold. Skips the per-tx event publish: the
      // recompute below fires the invoice-level lifecycle event, which is the
      // only signal merchants need for an admin-driven credit.
      const threshold = confirmationThreshold(orphan.chainId, deps.confirmationThresholds);
      const newStatus = orphan.confirmations >= threshold ? "confirmed" : "detected";
      const confirmedAt = newStatus === "confirmed" ? (orphan.confirmedAt ?? now) : orphan.confirmedAt;

      await deps.db
        .update(transactions)
        .set({
          invoiceId: parsed.invoiceId,
          status: newStatus,
          confirmedAt
        })
        .where(eq(transactions.id, id));

      const before = invoiceRow.status;
      const after = await recomputeInvoiceFromTransactions(deps, invoiceRow, now, {
        viaAdminOverride: true
      });

      deps.logger.info("orphan attributed by admin", {
        txId: id,
        invoiceId: parsed.invoiceId,
        merchantId: invoiceRow.merchantId,
        before,
        after
      });

      return c.json(
        {
          attribution: {
            txId: id,
            invoiceId: parsed.invoiceId,
            invoiceStatusBefore: before,
            invoiceStatusAfter: after
          }
        },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  app.post("/orphan-transactions/:id/dismiss", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = DismissOrphanSchema.parse(body);
      const now = deps.clock.now().getTime();

      const [orphan] = await deps.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, id))
        .limit(1);
      if (!orphan) {
        return c.json(
          { error: { code: "ORPHAN_NOT_FOUND", message: `No transaction with id ${id}` } },
          404
        );
      }
      if (orphan.invoiceId !== null) {
        return c.json(
          {
            error: {
              code: "NOT_ORPHAN",
              message: "Transaction is attributed to an invoice; dismiss only applies to orphans."
            }
          },
          409
        );
      }
      if (orphan.dismissedAt !== null) {
        return c.json(
          {
            error: {
              code: "ALREADY_DISMISSED",
              message: "Orphan was already dismissed."
            }
          },
          409
        );
      }

      await deps.db
        .update(transactions)
        .set({ dismissedAt: now, dismissReason: parsed.reason })
        .where(eq(transactions.id, id));

      deps.logger.info("orphan dismissed by admin", {
        txId: id,
        chainId: orphan.chainId,
        reason: parsed.reason
      });

      return c.json(
        {
          dismissal: {
            txId: id,
            dismissedAt: new Date(now).toISOString(),
            reason: parsed.reason
          }
        },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Manual on-chain backfill for a specific address. Calls the chain
  // adapter's scanIncoming for this (address, token-set) over the requested
  // window, diffs the results against what's already in `transactions`, and
  // ingests the missing rows via ingestDetectedTransfer — so normal orphan /
  // cooldown / invoice-match rules apply identically to push-ingested rows.
  //
  // Operator use: "merchant complained a payment never showed up; verify the
  // gateway saw everything that actually hit their receive address". The
  // endpoint is idempotent — already-stored txs are silently skipped via the
  // UNIQUE (chain_id, tx_hash, log_index) constraint.
  app.post("/audit-address", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = AuditAddressSchema.parse(body);
      const chainAdapter = findChainAdapter(deps, parsed.chainId);
      const canonical = chainAdapter.canonicalizeAddress(parsed.address);

      // Default lookback: 30 days. Long enough for forensic work on a
      // customer complaint that took a few weeks to surface; the adapter's
      // own per-chain max-scan window still clamps the final range.
      const sinceMs = parsed.sinceMs ?? deps.clock.now().getTime() - 30 * 24 * 60 * 60 * 1000;

      // Every known token on this chain + the native symbol. Tokens not
      // held by the address produce zero-hit scans (cheap for EVM's
      // per-contract log query, free for Tron/Solana's address-scoped APIs).
      const registeredTokens = TOKEN_REGISTRY.filter((t) => t.chainId === parsed.chainId).map(
        (t) => t.symbol
      );
      const nativeSymbol = chainAdapter.nativeSymbol(parsed.chainId as ChainId);
      const tokens = Array.from(new Set<TokenSymbol>([...registeredTokens, nativeSymbol]));

      const transfers = await chainAdapter.scanIncoming({
        chainId: parsed.chainId as ChainId,
        addresses: [canonical],
        tokens,
        sinceMs
      });

      let inserted = 0;
      let alreadyPresent = 0;
      const insertedTxIds: string[] = [];
      for (const transfer of transfers) {
        const result = await ingestDetectedTransfer(deps, transfer);
        if (result.inserted) {
          inserted += 1;
          if (result.transactionId !== undefined) insertedTxIds.push(result.transactionId);
        } else {
          alreadyPresent += 1;
        }
      }

      deps.logger.info("audit-address completed", {
        chainId: parsed.chainId,
        address: canonical,
        sinceMs,
        scanned: transfers.length,
        inserted,
        alreadyPresent
      });

      return c.json(
        {
          audit: {
            chainId: parsed.chainId,
            address: canonical,
            sinceMs,
            scanned: transfers.length,
            inserted,
            alreadyPresent,
            insertedTxIds
          }
        },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Runtime migration apply. Node/Deno already run migrations at boot — this
  // endpoint is the same set, exposed for (a) the ops panel's "reapply"
  // button and (b) restarting a Node worker after a hot-patch of the
  // `drizzle/migrations` directory. Workers/Vercel-Edge have no filesystem
  // at runtime so `deps.migrationsFolder` is absent — operators apply via
  // `npx drizzle-kit push` against TURSO_URL, and this endpoint surfaces
  // 501 so nobody thinks they've run migrations when they haven't.
  app.post("/migrate", async (c) => {
    if (deps.migrationsFolder === undefined) {
      return c.json(
        {
          error: {
            code: "MIGRATIONS_NOT_BUNDLED",
            message:
              "This runtime has no filesystem. Apply migrations CLI-side with `npx drizzle-kit push` pointed at TURSO_URL / TURSO_AUTH_TOKEN."
          }
        },
        501
      );
    }
    try {
      // Drizzle's migrator is idempotent; it reads `meta/_journal.json` and
      // applies only migrations not yet recorded in `__drizzle_migrations`.
      await drizzleMigrate(deps.db, { migrationsFolder: deps.migrationsFolder });
      deps.logger.info("admin /migrate", { folder: deps.migrationsFolder });
      return c.json({ ok: true, folder: deps.migrationsFolder }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // Operator balance snapshot: walks pool + fee wallets across every
  // configured chain, asks each chain adapter for ALL token balances in one
  // call, and joins with the price oracle for USD totals. Output is a
  // family → chain → address tree with per-token roll-ups at every level.
  //
  // Cached for 60s in CacheStore so a dashboard auto-refresh can't melt the
  // RPC budget. The cache key includes the query string so scoped lookups
  // (single chain / single address) get their own slot.
  app.get("/balances", async (c) => {
    try {
      const familyParam = c.req.query("family");
      const chainIdParam = c.req.query("chainId");
      const kindParam = c.req.query("kind");
      const addressParam = c.req.query("address");
      const liveParam = c.req.query("live");

      const opts: Parameters<typeof computeBalanceSnapshot>[1] = {};
      if (familyParam !== undefined) {
        const f = ChainFamilySchema.safeParse(familyParam);
        if (!f.success) {
          return c.json({ error: { code: "BAD_FAMILY", message: "family must be one of: evm, tron, solana" } }, 400);
        }
        opts.family = f.data;
      }
      if (chainIdParam !== undefined) {
        const n = Number(chainIdParam);
        if (!Number.isFinite(n) || n <= 0) {
          return c.json({ error: { code: "BAD_CHAIN_ID", message: "chainId must be a positive integer" } }, 400);
        }
        opts.chainId = n as ChainId;
      }
      if (kindParam !== undefined) {
        // The legacy "fee" kind is silently coerced to "pool" — every HD
        // address is a payout source now, no separate fee-wallet kind exists.
        if (kindParam !== "pool" && kindParam !== "fee") {
          return c.json({ error: { code: "BAD_KIND", message: "kind must be 'pool'" } }, 400);
        }
        opts.kind = "pool";
      }
      if (addressParam !== undefined) {
        opts.address = addressParam;
      }
      if (liveParam === "true" || liveParam === "1") {
        opts.live = true;
      }

      // Cache key includes the mode so db-derived and rpc results don't
      // clobber each other.
      const mode = opts.live === true ? "rpc" : "db";
      const cacheKey = "admin:balances:" + mode + ":" +
        [opts.family ?? "*", opts.chainId ?? "*", opts.kind ?? "*", opts.address ?? "*"].join(":");
      const cached = await deps.cache.getJSON<BalanceSnapshot>(cacheKey);
      if (cached !== null) {
        return c.json({ snapshot: cached, cached: true }, 200);
      }
      const snapshot = await computeBalanceSnapshot(deps, opts);
      // TTL is mode-dependent: rpc snapshots are expensive so 60s guards
      // against dashboard refresh hammering; db snapshots are ~50ms so a
      // short 5s TTL keeps numbers fresh without re-querying per request.
      const ttlSeconds = opts.live === true ? 60 : 5;
      await deps.cache.putJSON(cacheKey, snapshot, { ttlSeconds });
      return c.json({ snapshot, cached: false }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // ---- fee wallets ----
  //
  // Per-family configuration surface for the optional "fee wallet" gas-payer
  // topology. Registering a fee wallet on a family where the chain adapter
  // reports capability != "none" (Solana co-sign, Tron delegate) lets the
  // planner route that family's payouts through the fee-wallet path — source
  // pool addresses no longer need their own native for gas. EVM is declared
  // "none" until account-abstraction lands; the endpoints still accept
  // registration for EVM so operators can pre-register before the capability
  // flips on, but the planner ignores it.

  // GET — list the configured fee wallets across every family. The response
  // shape is always the full family set with `configured: null` for unset
  // families so the frontend can render a complete matrix without a second
  // "which families does the chain registry know about" call.
  app.get("/fee-wallets", async (c) => {
    try {
      const families: readonly ChainFamily[] = ["evm", "tron", "solana"];
      const rows = await Promise.all(
        families.map(async (family) => {
          const rec = await deps.feeWalletStore.get(family);
          // Find a chain in this family to query capability (it's the same
          // across chainIds within a family for every adapter we ship).
          const adapter = deps.chains.find((a) => a.family === family);
          const capability = adapter
            ? adapter.feeWalletCapability(adapter.supportedChainIds[0]!)
            : "none";
          return {
            family,
            capability,
            configured: rec === null ? null : { mode: rec.mode, address: rec.address }
          };
        })
      );
      return c.json({ feeWallets: rows }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // POST .../use-pool — register an existing HD pool address as the fee
  // wallet for this family. Lowest-friction path: no new secret material,
  // same derivation pool payouts already rely on. Preferred option for
  // operators who don't have a pre-existing staked/funded wallet to import.
  app.post("/fee-wallets/:family/use-pool", async (c) => {
    const rawFamily = c.req.param("family");
    const family = ChainFamilySchema.safeParse(rawFamily);
    if (!family.success) {
      return c.json(
        { error: { code: "BAD_FAMILY", message: "family must be one of: evm, tron, solana" } },
        400
      );
    }
    const body = (await c.req.json().catch(() => null)) as { address?: unknown } | null;
    if (body === null || typeof body.address !== "string" || body.address.length === 0) {
      return c.json(
        { error: { code: "BAD_JSON", message: "Expected { address: string }" } },
        400
      );
    }
    try {
      // Resolve the chain adapter so we can canonicalize the address. Without
      // this, operators could pass "0xABC..." on EVM and "0xabc..." would
      // mismatch the pool row stored in lowercase — fee-wallet sign path
      // would then fail its FK lookup at signing time. Canonicalize up front.
      const adapter = deps.chains.find((a) => a.family === family.data);
      if (!adapter) {
        return c.json(
          { error: { code: "NO_ADAPTER", message: `No chain adapter wired for family='${family.data}'` } },
          400
        );
      }
      let canonical: string;
      try {
        canonical = adapter.canonicalizeAddress(body.address);
      } catch {
        return c.json(
          { error: { code: "INVALID_ADDRESS", message: `Address ${body.address} is not valid for family='${family.data}'` } },
          400
        );
      }
      // Verify the address actually exists in the pool for this family. A
      // dangling fee-wallet pointing at a non-existent pool row is a
      // configuration bug we catch NOW rather than at signing time.
      const [poolRow] = await deps.db
        .select({ id: addressPool.id })
        .from(addressPool)
        .where(and(eq(addressPool.family, family.data), eq(addressPool.address, canonical)))
        .limit(1);
      if (!poolRow) {
        return c.json(
          {
            error: {
              code: "POOL_ADDRESS_NOT_FOUND",
              message: `No address_pool row for family='${family.data}', address='${canonical}'. Use /admin/pool/initialize first, or pick an address listed by /admin/balances?family=${family.data}.`
            }
          },
          404
        );
      }
      const saved = await deps.feeWalletStore.put({
        family: family.data,
        mode: "hd-pool",
        address: canonical
      });
      return c.json({ feeWallet: saved }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // POST .../import — register an externally-generated wallet by uploading
  // its private key. Ciphertext is written to the DB; plaintext lives in
  // memory only during the encrypt call. Intended for operators who have
  // a pre-existing Tron wallet with accumulated staked TRX (re-staking
  // loses the 5-14 day unstake cooldown) or a Solana wallet whose key they
  // already manage via HSM / KMS — not the default recommendation.
  app.post("/fee-wallets/:family/import", async (c) => {
    const rawFamily = c.req.param("family");
    const family = ChainFamilySchema.safeParse(rawFamily);
    if (!family.success) {
      return c.json(
        { error: { code: "BAD_FAMILY", message: "family must be one of: evm, tron, solana" } },
        400
      );
    }
    const body = (await c.req.json().catch(() => null)) as { privateKey?: unknown } | null;
    if (body === null || typeof body.privateKey !== "string" || body.privateKey.length === 0) {
      return c.json(
        { error: { code: "BAD_JSON", message: "Expected { privateKey: <hex string> }" } },
        400
      );
    }
    try {
      const adapter = deps.chains.find((a) => a.family === family.data);
      if (!adapter) {
        return c.json(
          { error: { code: "NO_ADAPTER", message: `No chain adapter wired for family='${family.data}'` } },
          400
        );
      }
      // Derive the address from the private key so we never trust the caller's
      // claim of what address their key belongs to. We reuse deriveAddress
      // indirectly via a temporary index lookup isn't clean — instead each
      // adapter's address derivation is a different function shape (EVM from
      // privateKey via viem, Solana/Tron from raw bytes), and we don't have a
      // uniform "privateKeyToAddress" port method yet. Document this limitation
      // and defer strict address-derivation to a follow-up — for now, the
      // operator supplies the address and we trust it, same as Fireblocks
      // wallet-import flows do at the admin layer. Mismatch surfaces at first
      // payout attempt via the signer-mismatch guard we added to the EVM
      // adapter (and parallel guards in other adapters).
      //
      // TODO(fee-wallet/import): add `ChainAdapter.addressFromPrivateKey` so
      // import can verify the declared address before persisting, not after
      // the first failed payout.
      const declaredAddress = (body as { address?: unknown }).address;
      if (typeof declaredAddress !== "string" || declaredAddress.length === 0) {
        return c.json(
          {
            error: {
              code: "BAD_JSON",
              message: "Expected { privateKey: <hex>, address: <base58/hex string for family> }"
            }
          },
          400
        );
      }
      let canonical: string;
      try {
        canonical = adapter.canonicalizeAddress(declaredAddress);
      } catch {
        return c.json(
          { error: { code: "INVALID_ADDRESS", message: `Address ${declaredAddress} is not valid for family='${family.data}'` } },
          400
        );
      }
      const saved = await deps.feeWalletStore.put({
        family: family.data,
        mode: "imported",
        address: canonical,
        privateKey: body.privateKey
      });
      return c.json({ feeWallet: saved }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // DELETE — remove the fee wallet for a family. Idempotent (returns
  // `removed: false` when no row existed). After removal the planner falls
  // back to the self-pay / sponsor-topup flow immediately; no in-flight
  // payouts are affected because fee-wallet selection is a per-plan
  // decision, not a per-payout one.
  app.delete("/fee-wallets/:family", async (c) => {
    const rawFamily = c.req.param("family");
    const family = ChainFamilySchema.safeParse(rawFamily);
    if (!family.success) {
      return c.json(
        { error: { code: "BAD_FAMILY", message: "family must be one of: evm, tron, solana" } },
        400
      );
    }
    try {
      const removed = await deps.feeWalletStore.remove(family.data);
      return c.json({ removed }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  // ---- Tron Stake 2.0 resource ops ----
  //
  // Operator flow for enabling zero-TRX-burn USDT/USDC payouts on Tron:
  //   1. POST /fee-wallets/tron/use-pool  { address }     — pick (or create)
  //      a pool address to serve as the fee wallet, or /import an external.
  //   2. Fund the fee wallet with TRX (external transfer — operator's choice).
  //   3. POST /fee-wallets/tron/freeze    { balance, resource=ENERGY }
  //      Freezes the fee wallet's TRX (via FreezeBalanceV2), converting it
  //      into daily ENERGY allowance. Staked TRX is reclaimable — this is
  //      not a burn.
  //   4. POST /fee-wallets/tron/delegate  { receiver, balance, resource }
  //      One call per pool address the operator wants to delegate to (or
  //      a cron/script that fans out). Each delegation gives the receiver
  //      a permanent share of the fee wallet's energy until undelegated.
  //   5. (Later, to rebalance)
  //      POST /fee-wallets/tron/undelegate  { receiver, balance, resource }
  //      POST /fee-wallets/tron/unfreeze    { balance, resource }  (14-day
  //        unlock period before withdrawable)
  //
  // Every write op here signs with the fee wallet's private key (resolved
  // via signerStore under `{kind: "fee-wallet", family: "tron"}`) and
  // broadcasts via the Tron adapter's signAndBroadcast, reusing the same
  // signing path production payouts already go through.

  async function resolveTronOps(c: import("hono").Context): Promise<
    | { kind: "ok"; adapter: ReturnType<typeof findChainAdapter> & { tronBackend(chainId: number): ReturnType<ReturnType<typeof findChainAdapter>["getBalance"]> extends infer _ ? import("../../adapters/chains/tron/tron-rpc.js").TronRpcBackend : never }; feeWallet: { address: string } }
    | { kind: "error"; response: Response }
  > {
    // Fee wallet must be registered for this family.
    const rec = await deps.feeWalletStore.get("tron");
    if (!rec) {
      return {
        kind: "error",
        response: c.json(
          {
            error: {
              code: "NO_FEE_WALLET",
              message: "No Tron fee wallet is registered. Use POST /admin/fee-wallets/tron/use-pool or /import first."
            }
          },
          409
        )
      };
    }
    // Find the Tron adapter.
    const adapter = findChainAdapter(deps, TRON_MAINNET_CHAIN_ID);
    if (!isTronChainAdapter(adapter)) {
      return {
        kind: "error",
        response: c.json(
          {
            error: {
              code: "NO_TRON_ADAPTER",
              message: "Tron chain adapter is not wired on this deployment."
            }
          },
          500
        )
      };
    }
    return {
      kind: "ok",
      adapter: adapter as unknown as ReturnType<typeof findChainAdapter> & { tronBackend(chainId: number): import("../../adapters/chains/tron/tron-rpc.js").TronRpcBackend },
      feeWallet: { address: rec.address }
    };
  }

  // GET — resource snapshot for the Tron fee wallet: energy/bandwidth
  // limits + currently-available budgets. Operators watch this to decide
  // when to re-delegate or stake more.
  app.get("/fee-wallets/tron/resources", async (c) => {
    try {
      const resolved = await resolveTronOps(c);
      if (resolved.kind === "error") return resolved.response;
      const client = resolved.adapter.tronBackend(TRON_MAINNET_CHAIN_ID);
      const resources = await client.getAccountResources(resolved.feeWallet.address);
      return c.json({ feeWallet: resolved.feeWallet.address, resources }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  const ResourceKindSchema = z.enum(["ENERGY", "BANDWIDTH"]);

  const FreezeSchema = z.object({
    // TRX to freeze, in sun. 1 TRX = 1,000,000 sun. Minimum per Tron rules
    // is 1 TRX (1_000_000 sun).
    balance: z.number().int().min(1_000_000),
    resource: ResourceKindSchema
  });

  async function signAndBroadcastTronRaw(
    adapter: TronChainAdapterRet,
    unsignedRaw: { txID: string; raw_data_hex: string; raw_data: unknown }
  ): Promise<string> {
    // Reuse the existing signing path by constructing a minimal UnsignedTx
    // with the same shape buildTransfer emits. No feePayer is involved —
    // these admin ops always sign with a single key (the fee wallet's).
    const unsigned = {
      chainId: TRON_MAINNET_CHAIN_ID as unknown as import("../../core/types/chain.js").ChainId,
      raw: unsignedRaw,
      summary: "tron-admin-op"
    } as import("../../core/types/unsigned-tx.js").UnsignedTx;
    const privateKey = await deps.signerStore.get({ kind: "fee-wallet", family: "tron" });
    return adapter.signAndBroadcast(unsigned, privateKey);
  }

  app.post("/fee-wallets/tron/freeze", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = FreezeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_JSON",
            message: "Expected { balance: <sun>, resource: 'ENERGY' | 'BANDWIDTH' }. Minimum balance 1_000_000 (1 TRX)."
          }
        },
        400
      );
    }
    try {
      const resolved = await resolveTronOps(c);
      if (resolved.kind === "error") return resolved.response;
      const client = resolved.adapter.tronBackend(TRON_MAINNET_CHAIN_ID);
      const unsigned = await client.freezeBalanceV2({
        owner_address: resolved.feeWallet.address,
        frozen_balance: parsed.data.balance,
        resource: parsed.data.resource as TronResourceKind
      });
      const txHash = await signAndBroadcastTronRaw(resolved.adapter, unsigned);
      return c.json({ txHash, ...parsed.data }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  app.post("/fee-wallets/tron/unfreeze", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = FreezeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_JSON",
            message: "Expected { balance: <sun>, resource: 'ENERGY' | 'BANDWIDTH' }. A 14-day unlock period begins on broadcast; TRX is withdrawable after that."
          }
        },
        400
      );
    }
    try {
      const resolved = await resolveTronOps(c);
      if (resolved.kind === "error") return resolved.response;
      const client = resolved.adapter.tronBackend(TRON_MAINNET_CHAIN_ID);
      const unsigned = await client.unfreezeBalanceV2({
        owner_address: resolved.feeWallet.address,
        unfreeze_balance: parsed.data.balance,
        resource: parsed.data.resource as TronResourceKind
      });
      const txHash = await signAndBroadcastTronRaw(resolved.adapter, unsigned);
      return c.json({ txHash, ...parsed.data }, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  const DelegateSchema = z.object({
    // The pool address that will receive delegated resources.
    receiver: z.string().min(1).max(128),
    // Stake (in sun) to delegate — NOT the energy amount. 1 sun of stake
    // produces a network-variable amount of energy per day (query via
    // /fee-wallets/tron/resources to tune).
    balance: z.number().int().min(1_000_000),
    resource: ResourceKindSchema,
    // Optional 3-day lock so a delegation can't be reclaimed immediately.
    // Mitigates accidental unDelegate during script churn; for most use
    // cases leave false.
    lock: z.boolean().optional()
  });

  app.post("/fee-wallets/tron/delegate", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = DelegateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_JSON",
            message: "Expected { receiver: <base58 address>, balance: <sun>, resource: 'ENERGY' | 'BANDWIDTH', lock?: boolean }"
          }
        },
        400
      );
    }
    try {
      const resolved = await resolveTronOps(c);
      if (resolved.kind === "error") return resolved.response;
      // Canonicalize + sanity-check receiver: if it's a pool address we
      // verify it's in address_pool (so the operator doesn't accidentally
      // delegate to an unrelated wallet). Non-pool receivers are allowed
      // but warned — use-case covers delegating to sweep-master or sponsor
      // addresses that don't live in the pool.
      const canonical = resolved.adapter.canonicalizeAddress(parsed.data.receiver);
      const [poolRow] = await deps.db
        .select({ id: addressPool.id })
        .from(addressPool)
        .where(and(eq(addressPool.family, "tron"), eq(addressPool.address, canonical)))
        .limit(1);
      const receiverIsInPool = poolRow !== undefined;

      const client = resolved.adapter.tronBackend(TRON_MAINNET_CHAIN_ID);
      const unsigned = await client.delegateResource({
        owner_address: resolved.feeWallet.address,
        receiver_address: canonical,
        balance: parsed.data.balance,
        resource: parsed.data.resource as TronResourceKind,
        ...(parsed.data.lock === true ? { lock: true } : {})
      });
      const txHash = await signAndBroadcastTronRaw(resolved.adapter, unsigned);
      return c.json(
        {
          txHash,
          receiver: canonical,
          balance: parsed.data.balance,
          resource: parsed.data.resource,
          lock: parsed.data.lock === true,
          receiverIsInPool
        },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  const UndelegateSchema = z.object({
    receiver: z.string().min(1).max(128),
    balance: z.number().int().min(1_000_000),
    resource: ResourceKindSchema
  });

  app.post("/fee-wallets/tron/undelegate", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UndelegateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_JSON",
            message: "Expected { receiver: <base58 address>, balance: <sun>, resource: 'ENERGY' | 'BANDWIDTH' }"
          }
        },
        400
      );
    }
    try {
      const resolved = await resolveTronOps(c);
      if (resolved.kind === "error") return resolved.response;
      const canonical = resolved.adapter.canonicalizeAddress(parsed.data.receiver);
      const client = resolved.adapter.tronBackend(TRON_MAINNET_CHAIN_ID);
      const unsigned = await client.undelegateResource({
        owner_address: resolved.feeWallet.address,
        receiver_address: canonical,
        balance: parsed.data.balance,
        resource: parsed.data.resource as TronResourceKind
      });
      const txHash = await signAndBroadcastTronRaw(resolved.adapter, unsigned);
      return c.json(
        { txHash, receiver: canonical, balance: parsed.data.balance, resource: parsed.data.resource },
        200
      );
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  return app;
}

// Local alias to narrow the adapter type once `isTronChainAdapter` has
// already confirmed the shape. Referenced from `signAndBroadcastTronRaw`.
type TronChainAdapterRet = ReturnType<typeof findChainAdapter> & {
  tronBackend(chainId: number): import("../../adapters/chains/tron/tron-rpc.js").TronRpcBackend;
};

const InitializePoolSchema = z.object({
  families: z.array(ChainFamilySchema).min(1).default(["evm", "tron", "solana"] as const),
  initialSize: z.number().int().min(1).max(500).default(5)
});

function bytesToRandomHex(numBytes: number): string {
  const bytes = new Uint8Array(numBytes);
  getRandomValues(bytes);
  return bytesToHex(bytes);
}

