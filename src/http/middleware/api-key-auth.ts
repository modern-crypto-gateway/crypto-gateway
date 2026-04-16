import type { Context, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { sha256Hex } from "../../adapters/crypto/subtle.js";

// Merchant API-key authentication.
//
// Accepts either:
//   Authorization: Bearer <key>
//   X-API-Key: <key>
//
// Stored form is SHA-256(plaintext) in `merchants.api_key_hash`. We hash the
// incoming key and do a single SELECT by hash — no plaintext enumeration, no
// per-merchant timing leak beyond the hash lookup itself. SQLite's lookup is
// effectively constant for a hashed-indexed column.

export interface AuthedVariables {
  merchantId: string;
}

export function apiKeyAuth(deps: AppDeps): MiddlewareHandler<{ Variables: AuthedVariables }> {
  return async (c: Context<{ Variables: AuthedVariables }>, next) => {
    const headerAuth = c.req.header("authorization");
    const headerApiKey = c.req.header("x-api-key");
    const key = extractBearer(headerAuth) ?? headerApiKey;
    if (!key) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    const hash = await sha256Hex(key);
    const merchant = await deps.db
      .prepare("SELECT id, active FROM merchants WHERE api_key_hash = ?")
      .bind(hash)
      .first<{ id: string; active: number }>();

    if (!merchant || merchant.active !== 1) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    c.set("merchantId", merchant.id);
    await next();
    return;
  };
}

function extractBearer(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match?.[1];
}
