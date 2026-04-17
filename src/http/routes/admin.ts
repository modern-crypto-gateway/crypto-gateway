import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../core/app-deps.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import { registerFeeWallet } from "../../core/domain/payout.service.js";
import { getStats as getPoolStats, initializePool } from "../../core/domain/pool.service.js";
import { ChainFamilySchema, type ChainFamily } from "../../core/types/chain.js";
import { sha256Hex, bytesToHex, getRandomValues } from "../../adapters/crypto/subtle.js";
import { parseAlchemyChainsEnv } from "../../adapters/chains/evm/alchemy-rpc.js";
import {
  alchemyAdminClient,
  type AlchemyAdminClient
} from "../../adapters/detection/alchemy-admin-client.js";
import { bootstrapAlchemyWebhooks } from "../../adapters/detection/bootstrap-alchemy-webhooks.js";
import { dbAlchemyRegistryStore } from "../../adapters/detection/alchemy-registry-store.js";
import { readAlchemyNotifyToken } from "../../adapters/detection/alchemy-token.js";
import { assertWebhookUrlSafe } from "../../core/domain/url-safety.js";
import { applyMigrations } from "../../adapters/db/migration-runner.js";
import { renderError } from "../middleware/error-handler.js";
import { adminAuth } from "../middleware/admin-auth.js";

// Operator-only surface. All routes require the shared admin key; the rest of
// the gateway authenticates merchants via their own API key. Keep this
// intentionally narrow — every endpoint here is a sharp edge.

const CreateMerchantSchema = z.object({
  name: z.string().min(1).max(128),
  webhookUrl: z.string().url().optional(),
  // If present, a 64-hex-char plaintext signing secret for outbound webhooks.
  // Omit to generate a fresh one; the plaintext is returned once in the response.
  webhookSecret: z.string().length(64).regex(/^[0-9a-f]+$/).optional()
});

const RegisterFeeWalletSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string().min(1).max(128),
  // Human-readable label used as the SignerStore scope key ("hot-1", "cold-archive", ...)
  label: z.string().min(1).max(64),
  // Plaintext private key. Put into the SignerStore at scope
  // { kind: 'fee-wallet', family, label }. The route never echoes it back.
  privateKey: z.string().min(1).max(256),
  family: z.enum(["evm", "tron", "solana"] as const)
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

// Router options allow tests to inject a fake Alchemy admin client without
// spinning up an HTTP mock. Production constructs the client from env inside
// the handler.
export interface AdminRouterOptions {
  alchemyAdminClientFactory?: (authToken: string) => AlchemyAdminClient;
}

export function adminRouter(deps: AppDeps, opts: AdminRouterOptions = {}): Hono {
  const app = new Hono();
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

      await deps.db
        .prepare(
          `INSERT INTO merchants
             (id, name, api_key_hash, webhook_url, webhook_secret_ciphertext, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          id,
          parsed.name,
          apiKeyHash,
          parsed.webhookUrl ?? null,
          webhookSecretCiphertext,
          now,
          now
        )
        .run();

      return c.json(
        {
          merchant: {
            id,
            name: parsed.name,
            webhookUrl: parsed.webhookUrl ?? null,
            active: true,
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

  app.post("/fee-wallets", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = RegisterFeeWalletSchema.parse(body);
      const chainAdapter = findChainAdapter(deps, parsed.chainId);
      if (!chainAdapter.validateAddress(parsed.address)) {
        return c.json({ error: { code: "INVALID_ADDRESS" } }, 400);
      }
      if (chainAdapter.family !== (parsed.family as ChainFamily)) {
        return c.json(
          { error: { code: "FAMILY_MISMATCH", message: `chainId ${parsed.chainId} is ${chainAdapter.family}, not ${parsed.family}` } },
          400
        );
      }
      const canonical = chainAdapter.canonicalizeAddress(parsed.address);

      await registerFeeWallet(deps, { chainId: parsed.chainId, address: canonical, label: parsed.label });
      await deps.signerStore.put(
        { kind: "fee-wallet", family: parsed.family, label: parsed.label },
        parsed.privateKey
      );
      return c.json({ feeWallet: { chainId: parsed.chainId, address: canonical, label: parsed.label } }, 201);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
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

  // Runtime migration apply. Node/Deno already run migrations at boot — this
  // endpoint is the same set, exposed for (a) the ops panel's "reapply"
  // button and (b) restarting a Node worker after a hot-patch of the
  // migrations directory. Workers/Vercel-Edge have no filesystem at runtime
  // so `deps.migrations` is absent — operators apply via `wrangler d1
  // migrations apply` or the Turso CLI, and this endpoint surfaces 501 so
  // nobody thinks they've run migrations when they haven't.
  app.post("/migrate", async (c) => {
    if (deps.migrations === undefined) {
      return c.json(
        {
          error: {
            code: "MIGRATIONS_NOT_BUNDLED",
            message:
              "This runtime ships without a bundled migration set. Run migrations via `wrangler d1 migrations apply <db>` (Workers) or the Turso migration CLI (Vercel Edge)."
          }
        },
        501
      );
    }
    try {
      const result = await applyMigrations(deps.db, deps.migrations);
      deps.logger.info("admin /migrate", {
        applied: result.applied,
        skipped: result.skipped.length
      });
      return c.json(result, 200);
    } catch (err) {
      return renderError(c, err, deps.logger);
    }
  });

  return app;
}

const InitializePoolSchema = z.object({
  families: z.array(ChainFamilySchema).min(1).default(["evm", "tron", "solana"] as const),
  initialSize: z.number().int().min(1).max(500).default(5)
});

function bytesToRandomHex(numBytes: number): string {
  const bytes = new Uint8Array(numBytes);
  getRandomValues(bytes);
  return bytesToHex(bytes);
}

