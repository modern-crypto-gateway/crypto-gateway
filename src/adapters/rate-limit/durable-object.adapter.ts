import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { RateLimiter, RateLimitResult } from "../../core/ports/rate-limit.port.js";

// Durable Object rate-limiter client. Each `consume` call:
//   1. Derives a DO instance id from the key (`idFromName`) — so every
//      caller hitting the same key lands on the same single-threaded
//      instance.
//   2. Forwards a POST to the DO with the limit + windowSeconds.
//   3. Parses the atomic result.
//
// Correctness vs cache-backed: the DO serializes requests (blockConcurrencyWhile)
// and persists its counter, so the classic get/put race that over-admits on
// CF KV is gone. This is the adapter to reach for when a leaked API key
// or a coordinated attack would otherwise blow past the cap.
//
// Cost note: DO calls bill per invocation + storage per transition. Still
// cheap for the admin / checkout / webhook-ingest rate limits (low QPS);
// the per-merchant API surface at high QPS would be fine too, but worth
// measuring before flipping over.

export function durableObjectRateLimiter(namespace: DurableObjectNamespace): RateLimiter {
  return {
    async consume({ key, limit, windowSeconds }): Promise<RateLimitResult> {
      const id = namespace.idFromName(key);
      const stub = namespace.get(id);
      const response = await stub.fetch("https://rate-limit.internal/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit, windowSeconds })
      });
      if (!response.ok) {
        // DO error path: fail-open would defeat the strictness guarantee,
        // but fail-closed turns a DO outage into a 429 storm. Pick
        // fail-open — the cache-backed path the adapter replaced would
        // have also failed open here (cache read returns null, counter
        // starts at 0). Log via the raw response; the middleware above
        // only reads the result payload.
        const body = await response.text().catch(() => "");
        throw new Error(`rate-limit DO returned ${response.status}: ${body.slice(0, 256)}`);
      }
      const parsed = (await response.json()) as RateLimitResult;
      return parsed;
    }
  };
}
