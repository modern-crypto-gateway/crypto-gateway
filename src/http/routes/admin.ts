import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import type { AppDeps } from "../../core/app-deps.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import { registerFeeWallet } from "../../core/domain/payout.service.js";
import type { ChainFamily } from "../../core/types/chain.js";
import { sha256Hex, bytesToHex, getRandomValues } from "../../adapters/crypto/subtle.js";
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

export function adminRouter(deps: AppDeps): Hono {
  const app = new Hono();
  app.use("*", adminAuth(deps));

  app.post("/merchants", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (body === null) {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }
    try {
      const parsed = CreateMerchantSchema.parse(body);
      const apiKey = `sk_${bytesToRandomHex(32)}`;
      const apiKeyHash = await sha256Hex(apiKey);
      const webhookSecret = parsed.webhookSecret ?? bytesToRandomHex(32);
      const id = globalThis.crypto.randomUUID();
      const now = deps.clock.now().getTime();

      await deps.db
        .prepare(
          `INSERT INTO merchants
             (id, name, api_key_hash, webhook_url, webhook_secret_hash, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          id,
          parsed.name,
          apiKeyHash,
          parsed.webhookUrl ?? null,
          parsed.webhookUrl ? webhookSecret : null,
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
      return handleError(c, err);
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
      return handleError(c, err);
    }
  });

  return app;
}

function bytesToRandomHex(numBytes: number): string {
  const bytes = new Uint8Array(numBytes);
  getRandomValues(bytes);
  return bytesToHex(bytes);
}

function handleError(c: Context, err: unknown): Response {
  if (err instanceof ZodError) {
    return c.json({ error: { code: "VALIDATION", details: err.issues } }, 400);
  }
  if (err instanceof Error) {
    console.error("[admin] unhandled error:", err);
    return c.json({ error: { code: "INTERNAL", message: err.message } }, 500);
  }
  return c.json({ error: { code: "INTERNAL" } }, 500);
}
