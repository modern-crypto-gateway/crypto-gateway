import type { DurableObjectState } from "@cloudflare/workers-types";

// Durable Object class for strict rate-limit counting. One instance per
// rate-limit key (the client adapter derives the instance id via
// `namespace.idFromName(key)`), so every caller that buckets to the same key
// lands on the same DO — and the DO is single-threaded, giving us honest
// atomic INCR semantics that CF KV cannot offer.
//
// Request body: { limit: number, windowSeconds: number }
// Response body: { allowed: boolean, limit, remaining, resetMs }
//
// Storage layout (per DO instance):
//   windowStart: number   — epoch ms of the current window's start
//   count:       number   — calls consumed in the current window
//
// When a request arrives in a new window we reset both fields atomically.
// We rely on `state.blockConcurrencyWhile` to serialize reads/writes so two
// near-simultaneous POSTs cannot both read count=0 and admit past the cap.

export class RateLimiterDurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    let body: { limit?: unknown; windowSeconds?: unknown };
    try {
      body = (await request.json()) as { limit?: unknown; windowSeconds?: unknown };
    } catch {
      return new Response(JSON.stringify({ error: "bad json" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    const limit = Number(body.limit);
    const windowSeconds = Number(body.windowSeconds);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      return new Response(JSON.stringify({ error: "invalid limit/windowSeconds" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }

    const result = await this.state.blockConcurrencyWhile(async () => {
      const windowMs = windowSeconds * 1000;
      const now = Date.now();
      const [storedStart, storedCount] = await Promise.all([
        this.state.storage.get<number>("windowStart"),
        this.state.storage.get<number>("count")
      ]);
      const currentWindowStart = Math.floor(now / windowMs) * windowMs;
      const resetMs = currentWindowStart + windowMs;

      let count: number;
      if (storedStart !== currentWindowStart) {
        // New window — reset the counter atomically with the start-stamp.
        count = 0;
      } else {
        count = storedCount ?? 0;
      }

      if (count >= limit) {
        // Persist the windowStart refresh even on deny so a stale stamp
        // from a prior window doesn't linger.
        if (storedStart !== currentWindowStart) {
          await this.state.storage.put({
            windowStart: currentWindowStart,
            count: 0
          });
        }
        return { allowed: false, limit, remaining: 0, resetMs };
      }

      const next = count + 1;
      await this.state.storage.put({
        windowStart: currentWindowStart,
        count: next
      });
      return { allowed: true, limit, remaining: Math.max(0, limit - next), resetMs };
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
}
