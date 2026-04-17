import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, createInvoiceViaApi, type BootedTestApp } from "../helpers/boot.js";

const MERCHANT_A = "00000000-0000-0000-0000-000000000001";
const MERCHANT_B = "00000000-0000-0000-0000-000000000002";

function authHeader(apiKey: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

describe("per-merchant rate limit on /api/v1/invoices", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({
      merchants: [
        { id: MERCHANT_A, name: "A" },
        { id: MERCHANT_B, name: "B" }
      ],
      rateLimits: { merchantPerMinute: 3 }
    });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("sets x-ratelimit-* headers on allowed responses", async () => {
    const apiKey = booted.apiKeys[MERCHANT_A]!;
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-ratelimit-limit")).toBe("3");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("2");
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns 429 with Retry-After once the per-merchant limit is exhausted", async () => {
    const apiKey = booted.apiKeys[MERCHANT_A]!;
    for (let i = 0; i < 3; i += 1) {
      const ok = await createInvoiceViaApi(booted, { merchantId: MERCHANT_A, amountRaw: "1" });
      expect(ok.id).toBeTruthy();
    }
    const res = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(apiKey),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("isolates buckets per merchant (exhausting A does not affect B)", async () => {
    for (let i = 0; i < 3; i += 1) {
      await createInvoiceViaApi(booted, { merchantId: MERCHANT_A, amountRaw: "1" });
    }
    // A's 4th request: 429
    const aFourth = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(booted.apiKeys[MERCHANT_A]!),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(aFourth.status).toBe(429);

    // B's first request: still fine.
    const bFirst = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(booted.apiKeys[MERCHANT_B]!),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(bFirst.status).toBe(201);
    expect(bFirst.headers.get("x-ratelimit-remaining")).toBe("2");
  });

  it("401 (bad API key) short-circuits before the limiter runs (no quota consumed)", async () => {
    // Hammer with a bogus key 10x — none of these should count against any real merchant.
    for (let i = 0; i < 10; i += 1) {
      const res = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: authHeader("sk_bogus"),
          body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
        })
      );
      expect(res.status).toBe(401);
      // No rate-limit header on 401 — the middleware never ran.
      expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    }
    // Merchant A still has full quota.
    const ok = await booted.app.fetch(
      new Request("http://test.local/api/v1/invoices", {
        method: "POST",
        headers: authHeader(booted.apiKeys[MERCHANT_A]!),
        body: JSON.stringify({ chainId: 999, token: "DEV", amountRaw: "1" })
      })
    );
    expect(ok.headers.get("x-ratelimit-remaining")).toBe("2");
  });
});

describe("per-IP rate limit on /checkout/:id", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ rateLimits: { checkoutPerMinute: 2 } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("throttles repeated checkout lookups from the same IP header", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1" });
    const url = `http://test.local/checkout/${invoice.id}`;
    const ip = "203.0.113.5";

    const r1 = await booted.app.fetch(new Request(url, { headers: { "x-forwarded-for": ip } }));
    const r2 = await booted.app.fetch(new Request(url, { headers: { "x-forwarded-for": ip } }));
    const r3 = await booted.app.fetch(new Request(url, { headers: { "x-forwarded-for": ip } }));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("different IPs get independent buckets", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1" });
    const url = `http://test.local/checkout/${invoice.id}`;

    // Exhaust IP 1.
    for (let i = 0; i < 2; i += 1) {
      await booted.app.fetch(new Request(url, { headers: { "x-forwarded-for": "203.0.113.5" } }));
    }
    const blocked = await booted.app.fetch(new Request(url, { headers: { "x-forwarded-for": "203.0.113.5" } }));
    expect(blocked.status).toBe(429);

    // IP 2 should still succeed.
    const fresh = await booted.app.fetch(new Request(url, { headers: { "x-forwarded-for": "198.51.100.9" } }));
    expect(fresh.status).toBe(200);
  });

  it("prefers CF-Connecting-IP when present (used on Workers)", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1" });
    const url = `http://test.local/checkout/${invoice.id}`;

    // Exhaust via cf-connecting-ip header.
    for (let i = 0; i < 2; i += 1) {
      await booted.app.fetch(new Request(url, { headers: { "cf-connecting-ip": "203.0.113.5" } }));
    }
    const blocked = await booted.app.fetch(new Request(url, { headers: { "cf-connecting-ip": "203.0.113.5" } }));
    expect(blocked.status).toBe(429);
  });

  it("extracts the leftmost (client) IP from a multi-entry X-Forwarded-For chain", async () => {
    const invoice = await createInvoiceViaApi(booted, { amountRaw: "1" });
    const url = `http://test.local/checkout/${invoice.id}`;
    // Client is 203.0.113.5; the proxies trail.
    const xff = "203.0.113.5, 198.51.100.9, 10.0.0.1";
    for (let i = 0; i < 2; i += 1) {
      await booted.app.fetch(new Request(url, { headers: { "x-forwarded-for": xff } }));
    }
    // Same leftmost client hits the cap.
    const blocked = await booted.app.fetch(
      new Request(url, { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } })
    );
    expect(blocked.status).toBe(429);
  });
});
