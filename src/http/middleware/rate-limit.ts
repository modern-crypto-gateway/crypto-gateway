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

// Best-effort client IP extraction. Checks headers common across Cloudflare,
// Vercel, AWS ALB, and generic reverse proxies. Falls back to "anonymous"
// which buckets unknown clients together — mildly unfair for shared NAT but
// safe for a public checkout/webhook endpoint that expects a proxy.
export function getClientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf !== undefined && cf.length > 0) return cf;
  const xff = c.req.header("x-forwarded-for");
  if (xff !== undefined && xff.length > 0) {
    // XFF is a comma-separated chain "client, proxy1, proxy2"; the leftmost
    // is the originating client (trust depends on upstream proxy hygiene).
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip");
  if (real !== undefined && real.length > 0) return real;
  return "anonymous";
}
