import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import { bytesToHex, hmacSha256 } from "../../adapters/crypto/subtle.js";

// Routes under /webhooks/*. Each provider gets its own endpoint so the
// signature scheme and payload shape can differ without shared coupling.
// Currently: /webhooks/alchemy.
//
// Ingest flow (all providers):
//   1. Read the RAW body (bytes, before parsing — HMAC is over raw bytes)
//   2. Verify the provider's signature against a pre-shared secret
//   3. Parse the JSON body
//   4. Hand to the provider's DetectionStrategy.handlePush -> DetectedTransfer[]
//   5. Ingest each DetectedTransfer via PaymentService
//
// We intentionally do NOT return details about why a verification failed — a
// blanket 401 denies an attacker a probing oracle.

export function webhooksIngestRouter(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/alchemy", async (c) => {
    const strategy = deps.pushStrategies["alchemy-notify"];
    if (!strategy?.handlePush) {
      // Provider not configured for this deployment. 404 rather than 401 so
      // operators can tell "nothing here" from "bad signature".
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Alchemy ingest not enabled" } }, 404);
    }

    const signingKey = deps.secrets.getOptional("ALCHEMY_NOTIFY_SIGNING_KEY");
    if (!signingKey) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Alchemy ingest not enabled" } }, 404);
    }

    const rawBody = await c.req.text();
    const providedSig = c.req.header("x-alchemy-signature");
    if (!providedSig) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    const computedSig = bytesToHex(await hmacSha256(signingKey, rawBody));
    if (!constantTimeEqualHex(providedSig, computedSig)) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }

    // Defer the ingest work off the request-handling path so slow DB writes
    // or downstream webhook fan-out don't block the provider's retry budget.
    // Provider semantics: Alchemy retries 5 times with backoff on non-2xx —
    // we acknowledge fast and do the real work in the background.
    deps.jobs.defer(
      async () => {
        const transfers = await strategy.handlePush!(deps, payload);
        for (const transfer of transfers) {
          await ingestDetectedTransfer(deps, transfer);
        }
      },
      { name: "alchemy-notify-ingest" }
    );

    return c.json({ received: true }, 200);
  });

  return app;
}

// Constant-time comparison over two hex strings. Fails early only on length
// mismatch (which is already public — the signature's length is a header field).
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
