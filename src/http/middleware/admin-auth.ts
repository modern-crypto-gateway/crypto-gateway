import type { MiddlewareHandler } from "hono";
import type { AppDeps } from "../../core/app-deps.js";

// Admin-key authentication for the /admin/* surface.
//
// Single shared secret in `ADMIN_KEY` (SecretsProvider). Compared in constant
// time against either:
//   Authorization: Bearer <key>
//   X-Admin-Key: <key>
//
// Intentionally simpler than the merchant scheme — this endpoint is for
// operators, not programmatic tenants, and a single rotated key matches how
// v1 works. Multi-admin / RBAC is a Phase 8+ concern.

export function adminAuth(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    const expected = deps.secrets.getOptional("ADMIN_KEY");
    if (!expected) {
      // If no admin key is set, the admin surface is bolted shut. 404 rather
      // than 401 so operators can tell "not enabled" from "bad key".
      return c.json({ error: { code: "NOT_CONFIGURED" } }, 404);
    }

    const headerAuth = c.req.header("authorization");
    const headerAdminKey = c.req.header("x-admin-key");
    const provided = extractBearer(headerAuth) ?? headerAdminKey;
    if (!provided || !constantTimeEqual(expected, provided)) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    await next();
    return;
  };
}

function extractBearer(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match?.[1];
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
