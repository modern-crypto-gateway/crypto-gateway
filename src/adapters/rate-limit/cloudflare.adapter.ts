import type { RateLimit } from "@cloudflare/workers-types";
import type { RateLimiter, RateLimitResult } from "../../core/ports/rate-limit.port.js";

// Cloudflare built-in rate-limiter adapter.
//
// The platform binding (`ratelimits` in wrangler.jsonc) gives us atomic
// per-key counters enforced at the edge with no invocation cost on our side —
// strictly better than the Durable-Object path we used previously. One
// binding is ONE (limit, period) pair, so we carry a map of scope -> binding
// and dispatch by the prefix of the caller's key.
//
// Key convention (set by the rate-limit middleware):
//   "<scope>:<id>"                  — e.g. "admin:1.2.3.4"
//   "<scope>:<subscope>:<id>"       — e.g. "merchant-api:invoices:m_abc"
// We split on the FIRST colon: everything before picks the binding,
// everything after is the bucket key handed to the binding. Scopes that
// share a binding therefore get independent buckets via their trailing tail.
//
// What the adapter cannot report (CF binding's outcome is just `{ success }`):
//   - true `remaining` in the window  — we echo the configured limit on allow,
//     0 on deny. Informational header only; no caller depends on accuracy.
//   - true `resetMs`                  — we approximate as `now + windowMs`.
//     Used for Retry-After; the binding's actual sliding-window recovery is
//     usually faster, so clients retry no sooner than strictly needed.

export interface CloudflareRateLimiterConfig {
  // scope name -> binding. The scope is the prefix of the key produced by
  // rate-limit.ts (e.g. "admin", "checkout", "merchant-api"). Missing scopes
  // fall through to the `fallback` limiter.
  bindings: Readonly<Record<string, RateLimit | undefined>>;
  // Limiter used for any scope that has no matching binding. Typically the
  // cache-backed limiter, so operators can roll out one binding at a time.
  fallback: RateLimiter;
  now?: () => number;
}

export function cloudflareRateLimiter(config: CloudflareRateLimiterConfig): RateLimiter {
  const now = config.now ?? (() => Date.now());

  return {
    async consume({ key, limit, windowSeconds }): Promise<RateLimitResult> {
      const sepIndex = key.indexOf(":");
      const scope = sepIndex === -1 ? key : key.slice(0, sepIndex);
      const tail = sepIndex === -1 ? "" : key.slice(sepIndex + 1);
      const binding = config.bindings[scope];
      if (binding === undefined) {
        return config.fallback.consume({ key, limit, windowSeconds });
      }

      // The binding expects the full-string bucket key; we pass the tail so
      // two sub-scopes sharing a binding (e.g. invoices + payouts on the
      // merchant-api binding) get independent counters.
      const outcome = await binding.limit({ key: tail.length > 0 ? tail : key });
      const resetMs = now() + windowSeconds * 1000;
      return {
        allowed: outcome.success,
        limit,
        remaining: outcome.success ? limit : 0,
        resetMs
      };
    }
  };
}
