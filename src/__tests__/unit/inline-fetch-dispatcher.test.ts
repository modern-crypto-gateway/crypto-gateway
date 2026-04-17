import { describe, expect, it } from "vitest";
import { inlineFetchDispatcher } from "../../adapters/webhook-delivery/inline-fetch.adapter.js";
import { bytesToHex, hmacSha256 } from "../../adapters/crypto/subtle.js";

type FetchCall = { url: string; init: RequestInit };

function mockFetch(handler: (call: FetchCall, attempt: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  return {
    calls,
    fn: async (input: string, init?: RequestInit) => {
      const call: FetchCall = { url: input, init: init ?? {} };
      calls.push(call);
      return handler(call, calls.length);
    }
  };
}

describe("inlineFetchDispatcher", () => {
  it("signs the body with HMAC-SHA256 over the secret and sets all expected headers", async () => {
    const f = mockFetch(() => new Response(null, { status: 200 }));
    const dispatcher = inlineFetchDispatcher({ fetch: f.fn, maxAttempts: 1, retryBaseMs: 0 });

    const payload = { event: "invoice.detected", data: { foo: "bar" } };
    const secret = "shared-secret-abc";
    const result = await dispatcher.dispatch({
      url: "https://example.com/hook",
      payload,
      secret,
      idempotencyKey: "invoice.detected:abc:detected"
    });
    expect(result).toEqual({ delivered: true, statusCode: 200 });

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    const headers = new Headers(call.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-webhook-idempotency-key")).toBe("invoice.detected:abc:detected");
    expect(headers.get("x-webhook-attempt")).toBe("1");

    // Verify the signature header matches what we'd compute over the raw body.
    const expectedSig = bytesToHex(await hmacSha256(secret, call.init.body as string));
    expect(headers.get("x-webhook-signature")).toBe(expectedSig);
  });

  it("retries on 5xx up to maxAttempts and returns the last status on exhaustion", async () => {
    const f = mockFetch(() => new Response(null, { status: 503 }));
    const dispatcher = inlineFetchDispatcher({ fetch: f.fn, maxAttempts: 3, retryBaseMs: 1 });
    const result = await dispatcher.dispatch({
      url: "https://example.com/hook",
      payload: {},
      secret: "s",
      idempotencyKey: "k"
    });
    expect(f.calls).toHaveLength(3);
    expect(result.delivered).toBe(false);
    expect(result.statusCode).toBe(503);

    // Each attempt carries the same idempotency key and timestamp, but an incremented attempt number.
    const attempts = f.calls.map((c) => new Headers(c.init.headers).get("x-webhook-attempt"));
    expect(attempts).toEqual(["1", "2", "3"]);
    const keys = f.calls.map((c) => new Headers(c.init.headers).get("x-webhook-idempotency-key"));
    expect(new Set(keys).size).toBe(1);
    const timestamps = f.calls.map((c) => new Headers(c.init.headers).get("x-webhook-timestamp"));
    expect(new Set(timestamps).size).toBe(1);
  });

  it("does not retry on a non-retryable 4xx (e.g. 400)", async () => {
    const f = mockFetch(() => new Response(null, { status: 400 }));
    const dispatcher = inlineFetchDispatcher({ fetch: f.fn, maxAttempts: 5, retryBaseMs: 0 });
    const result = await dispatcher.dispatch({
      url: "https://example.com/hook",
      payload: {},
      secret: "s",
      idempotencyKey: "k"
    });
    expect(f.calls).toHaveLength(1);
    expect(result.delivered).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.error).toMatch(/non-retryable/i);
  });

  it("succeeds on a later retry after initial failures", async () => {
    const f = mockFetch((_c, attempt) =>
      attempt < 2 ? new Response(null, { status: 503 }) : new Response(null, { status: 200 })
    );
    const dispatcher = inlineFetchDispatcher({ fetch: f.fn, maxAttempts: 3, retryBaseMs: 1 });
    const result = await dispatcher.dispatch({
      url: "https://example.com/hook",
      payload: {},
      secret: "s",
      idempotencyKey: "k"
    });
    expect(result).toEqual({ delivered: true, statusCode: 200 });
    expect(f.calls).toHaveLength(2);
  });

  it("retries on transport errors (fetch throws)", async () => {
    let attempts = 0;
    const fetchFn = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("network down");
      return new Response(null, { status: 200 });
    };
    const dispatcher = inlineFetchDispatcher({ fetch: fetchFn, maxAttempts: 4, retryBaseMs: 1 });
    const result = await dispatcher.dispatch({
      url: "https://example.com/hook",
      payload: {},
      secret: "s",
      idempotencyKey: "k"
    });
    expect(result.delivered).toBe(true);
    expect(attempts).toBe(3);
  });
});
