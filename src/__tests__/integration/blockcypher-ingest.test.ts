import { describe, expect, it } from "vitest";
import type { DetectionStrategy } from "../../core/ports/detection.port.js";
import { bootTestApp } from "../helpers/boot.js";

// POST /webhooks/blockcypher/:chainId — auth-token gating.
//
// BlockCypher payloads carry no HMAC; the only authentication is the
// `?token=` query param checked against the BLOCKCYPHER_INGEST_TOKEN env.
// The check is FAIL-CLOSED: with the env unset the route must reject every
// caller (404 NOT_CONFIGURED, matching the strategy-missing convention) —
// the payload's `outputs[].value` / `confirmations` are trusted downstream,
// so an open route would let anyone forge confirmed payments.

const INGEST_TOKEN = "bc-ingest-token-for-tests";

// Minimal valid-looking BlockCypher TX payload. The recording strategy below
// never projects it into transfers — these tests assert the auth gate, not
// the projection (covered by unit/blockcypher-notify.test.ts).
const TX_BODY = JSON.stringify({
  hash: "f".repeat(64),
  block_height: 100,
  confirmations: 3,
  outputs: [{ value: 50_000, addresses: ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"] }]
});

// DetectionStrategy stub that records every payload the route hands it, so
// tests can assert the handler was (or was not) reached past the auth gate.
function recordingStrategy(): { strategy: DetectionStrategy; pushes: unknown[] } {
  const pushes: unknown[] = [];
  const strategy: DetectionStrategy = {
    async handlePush(_deps, rawPayload) {
      pushes.push(rawPayload);
      return [];
    }
  };
  return { strategy, pushes };
}

function post(path: string): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: TX_BODY
  });
}

describe("POST /webhooks/blockcypher/:chainId", () => {
  it("rejects every caller when BLOCKCYPHER_INGEST_TOKEN is unset (fail-closed)", async () => {
    const { strategy, pushes } = recordingStrategy();
    const booted = await bootTestApp({
      pushStrategies: { "blockcypher-notify": strategy }
      // No BLOCKCYPHER_INGEST_TOKEN in secretsOverrides — ingest not configured.
    });
    try {
      // Without a token query param...
      const res = await booted.app.fetch(post("/webhooks/blockcypher/800"));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_CONFIGURED");

      // ...and even WITH one (an attacker guessing can't open the gate).
      const resGuess = await booted.app.fetch(post("/webhooks/blockcypher/800?token=guess"));
      expect(resGuess.status).toBe(404);

      await booted.deps.jobs.drain(500);
      expect(pushes).toHaveLength(0);
    } finally {
      await booted.close();
    }
  });

  it("rejects a wrong token with 401 UNAUTHORIZED (no detail leakage)", async () => {
    const { strategy, pushes } = recordingStrategy();
    const booted = await bootTestApp({
      pushStrategies: { "blockcypher-notify": strategy },
      secretsOverrides: { BLOCKCYPHER_INGEST_TOKEN: INGEST_TOKEN }
    });
    try {
      const res = await booted.app.fetch(post("/webhooks/blockcypher/800?token=wrong-token"));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message?: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(body.error.message).toBeUndefined();

      // Missing token param is just a wrong (empty) token → same 401.
      const resMissing = await booted.app.fetch(post("/webhooks/blockcypher/800"));
      expect(resMissing.status).toBe(401);

      await booted.deps.jobs.drain(500);
      expect(pushes).toHaveLength(0);
    } finally {
      await booted.close();
    }
  });

  it("accepts the correct token, injects chainId, and defers ingest", async () => {
    const { strategy, pushes } = recordingStrategy();
    const booted = await bootTestApp({
      pushStrategies: { "blockcypher-notify": strategy },
      secretsOverrides: { BLOCKCYPHER_INGEST_TOKEN: INGEST_TOKEN }
    });
    try {
      const res = await booted.app.fetch(
        post(`/webhooks/blockcypher/800?token=${INGEST_TOKEN}`)
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });

      // Ingest is deferred via jobs.defer — drain to flush.
      await booted.deps.jobs.drain(2_000);
      expect(pushes).toHaveLength(1);
      // The route injects the URL's chainId so the strategy can't be steered
      // by a payload-supplied chain.
      expect((pushes[0] as { chainId?: number }).chainId).toBe(800);
    } finally {
      await booted.close();
    }
  });

  it("404 NOT_CONFIGURED when the strategy is absent, even with a valid token", async () => {
    const booted = await bootTestApp({
      // Deliberately omit pushStrategies.
      secretsOverrides: { BLOCKCYPHER_INGEST_TOKEN: INGEST_TOKEN }
    });
    try {
      const res = await booted.app.fetch(
        post(`/webhooks/blockcypher/800?token=${INGEST_TOKEN}`)
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_CONFIGURED");
    } finally {
      await booted.close();
    }
  });

  it("400 BAD_CHAIN_ID on a non-numeric chainId path segment", async () => {
    const { strategy } = recordingStrategy();
    const booted = await bootTestApp({
      pushStrategies: { "blockcypher-notify": strategy },
      secretsOverrides: { BLOCKCYPHER_INGEST_TOKEN: INGEST_TOKEN }
    });
    try {
      const res = await booted.app.fetch(
        post(`/webhooks/blockcypher/not-a-chain?token=${INGEST_TOKEN}`)
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BAD_CHAIN_ID");
    } finally {
      await booted.close();
    }
  });
});
