import type { Context, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../core/app-deps.js";

// Rate-limit middleware factory. Each call returns a Hono middleware bound to
// a specific scope + key extractor — mount one per surface:
//
//   app.use(rateLimit(deps, {
//     scope: "merchant-api",
//     keyFn: (c) => c.get("merchantId") ?? null,  // after apiKeyAuth
//     limit: config.perMerchantLimit,
//     windowSeconds: 60
//   }));
//
// Returning `null` from keyFn disables rate limiting for that request (useful
// when auth hasn't run yet or the scope doesn't apply).
//
// Headers set on every request the middleware evaluates:
//   X-RateLimit-Limit      — configured cap
//   X-RateLimit-Remaining  — quota left in the current window
//   X-RateLimit-Reset      — unix seconds when the window rolls
//   Retry-After            — seconds until reset (ONLY when returning 429)

export interface RateLimitOptions {
  // Namespace for the key — keeps per-merchant buckets separate from per-IP
  // buckets even when identifiers happen to collide.
  scope: string;
  // Extract the identifier from the request. Return `null` to skip limiting.
  keyFn: (c: Context) => string | null;
  limit: number;
  windowSeconds: number;
}

export function rateLimit(deps: AppDeps, opts: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const id = opts.keyFn(c);
    if (id === null) {
      await next();
      return;
    }

    const result = await deps.rateLimiter.consume({
      key: `${opts.scope}:${id}`,
      limit: opts.limit,
      windowSeconds: opts.windowSeconds
    });

    c.header("x-ratelimit-limit", String(result.limit));
    c.header("x-ratelimit-remaining", String(result.remaining));
    c.header("x-ratelimit-reset", String(Math.ceil(result.resetMs / 1000)));

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1000));
      c.header("retry-after", String(retryAfterSeconds));
      deps.logger.warn("rate limit exceeded", {
        scope: opts.scope,
        key: id,
        limit: opts.limit,
        windowSeconds: opts.windowSeconds
      });
      return c.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests" } },
        429
      );
    }

    await next();
    return;
  };
}

// Client-IP extraction for rate-limit bucketing. ONLY consults headers the
// operator has explicitly allow-listed via `deps.rateLimits.trustedIpHeaders`
// — a request that arrives with, say, an unsolicited `x-forwarded-for` header
// through a runtime that doesn't terminate a trusted proxy is ignored and
// buckets under "anonymous". This is the fix for the classic XFF-spoof
// quota-drain: an attacker can't impersonate a victim's IP just by setting
// the header.
//
// Headers are consulted in the configured order; first non-empty wins.
// XFF-style comma chains are split and only the leftmost (originating client)
// entry is used — trustworthy ONLY when the upstream proxy you terminate at
// strips any client-supplied XFF before forwarding. Configure accordingly.
//
// Falling back to "anonymous" buckets unknown clients together — slightly
// unfair for shared NAT but safe for a public checkout/webhook endpoint
// whose normal callers are expected to arrive through a trusted proxy.
export function getClientIp(c: Context, trustedHeaders: readonly string[] = []): string {
  for (const headerName of trustedHeaders) {
    const value = c.req.header(headerName);
    if (value === undefined || value.length === 0) continue;
    // Comma-separated chains (XFF shape) take the leftmost entry.
    const first = value.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  return "anonymous";
}
