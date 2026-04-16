// RateLimiter port. Intentionally minimal surface so a future Redis-INCR,
// Cloudflare Durable Object, or in-memory backend can all slot in with the
// same contract. The port speaks buckets-per-key, not HTTP — the middleware
// is responsible for mapping request shape to a key and consuming the result.

export interface RateLimitResult {
  // true = the call counts against the quota and should proceed.
  // false = the caller exceeded the quota; the middleware returns 429.
  allowed: boolean;
  // Requested limit (echoed for the `X-RateLimit-Limit` header).
  limit: number;
  // Remaining allowance in the CURRENT window, after this call.
  remaining: number;
  // Epoch milliseconds when the current window resets. The middleware converts
  // to seconds for the `X-RateLimit-Reset` header + the `Retry-After` header.
  resetMs: number;
}

export interface RateLimiter {
  // Atomic semantics are advisory. Cache-backed implementations on eventually
  // consistent stores (CF KV) may over-admit by a handful of requests per
  // window under concurrent burst — that is acceptable for fairness limits,
  // not for hard security gates. For strict caps use the future Durable
  // Objects adapter.
  consume(args: { key: string; limit: number; windowSeconds: number }): Promise<RateLimitResult>;
}
