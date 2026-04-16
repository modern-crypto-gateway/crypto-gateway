import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, type BootedTestApp } from "../helpers/boot.js";

const CRON_SECRET = "super-cron-secret";

describe("POST /internal/cron/tick", () => {
  let booted: BootedTestApp;

  beforeEach(async () => {
    booted = await bootTestApp({ secretsOverrides: { CRON_SECRET } });
  });

  afterEach(async () => {
    await booted.close();
  });

  it("runs all scheduled jobs when authenticated, returning an outcome per job", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/internal/cron/tick", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}` }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      result: Record<string, { ok: boolean; value?: unknown; error?: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.result).toHaveProperty("pollPayments");
    expect(body.result).toHaveProperty("confirmTransactions");
    expect(body.result).toHaveProperty("executeReservedPayouts");
    expect(body.result).toHaveProperty("confirmPayouts");
    // Every job should succeed against the empty-state test DB.
    for (const [_name, outcome] of Object.entries(body.result)) {
      expect(outcome.ok).toBe(true);
    }
  });

  it("returns 401 when the bearer token is missing", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/internal/cron/tick", { method: "POST" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the bearer token is wrong", async () => {
    const res = await booted.app.fetch(
      new Request("http://test.local/internal/cron/tick", {
        method: "POST",
        headers: { authorization: "Bearer nope" }
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when CRON_SECRET is not configured (endpoint disabled)", async () => {
    const noSecret = await bootTestApp({}); // no CRON_SECRET
    try {
      const res = await noSecret.app.fetch(
        new Request("http://test.local/internal/cron/tick", {
          method: "POST",
          headers: { authorization: "Bearer anything" }
        })
      );
      expect(res.status).toBe(404);
    } finally {
      await noSecret.close();
    }
  });
});
