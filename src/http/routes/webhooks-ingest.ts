import { Hono } from "hono";
import type { AppDeps } from "../../core/app-deps.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import { bytesToHex, hmacSha256 } from "../../adapters/crypto/subtle.js";
import { dbAlchemyRegistryStore } from "../../adapters/detection/alchemy-registry-store.js";
import { getClientIp, rateLimit } from "../middleware/rate-limit.js";

// Routes under /webhooks/*. Each provider gets its own endpoint so the
// signature scheme and payload shape can differ without shared coupling.
// Currently: /webhooks/alchemy.
//
// Ingest flow (Alchemy):
//   1. Read the RAW body (bytes, before any parsing — HMAC is over raw bytes)
//   2. Reject oversize payloads (body-size cap protects JSON.parse from DoS
//      before we've authenticated the caller)
//   3. Parse the JSON body to extract `webhookId` — needed BEFORE HMAC verify
//      because the signing key is per-webhook in the registry
//   4. Resolve the HMAC signing key: registry lookup by `webhookId`, then env
//      `ALCHEMY_NOTIFY_SIGNING_KEY` fallback (legacy/single-chain deployments)
//   5. Verify HMAC-SHA256 in constant time against the resolved key
//   6. Hand parsed payload to the DetectionStrategy and ingest transfers
//
// We intentionally do NOT return details about why a verification failed — a
// blanket 401 denies an attacker a probing oracle.

// Size cap on the raw body. Alchemy ADDRESS_ACTIVITY payloads are typically
// < 10 KB even for bursty blocks; 64 KB gives comfortable headroom without
// opening a JSON-parse DoS vector.
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export function webhooksIngestRouter(deps: AppDeps): Hono {
  const app = new Hono();

  // Per-IP limit to stop an attacker from flooding the HMAC-verification path
  // with bad signatures (the verify is cheap but not free). Legitimate
  // providers originate from a narrow set of IPs; 300/min/IP is well above
  // Alchemy's normal rate and still protects the surface.
  app.use(
    "*",
    rateLimit(deps, {
      scope: "webhook-ingest",
      keyFn: (c) => getClientIp(c),
      limit: deps.rateLimits.webhookIngestPerMinute,
      windowSeconds: 60
    })
  );

  app.post("/alchemy", async (c) => {
    const strategy = deps.pushStrategies["alchemy-notify"];
    if (!strategy?.handlePush) {
      // Provider not configured for this deployment. 404 rather than 401 so
      // operators can tell "nothing here" from "bad signature".
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Alchemy ingest not enabled" } }, 404);
    }

    const rawBody = await c.req.text();
    if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, 413);
    }

    const providedSig = c.req.header("x-alchemy-signature");
    if (!providedSig) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    // Parse the JSON once, pre-auth. Needed to extract `webhookId` for the
    // per-chain signing-key lookup. An attacker can't forge a valid HMAC
    // without our key, so the dispatch after verify is still gated — parsing
    // unverified JSON is safe as long as the body size is bounded (above).
    let payload: { webhookId?: string } & Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }

    // Resolve the signing key: DB registry by webhookId first, env var as
    // legacy fallback. Single-chain deployments that set only the env var
    // keep working without a bootstrap-registry row.
    const registryStore = dbAlchemyRegistryStore(deps.db);
    let signingKey: string | undefined;
    if (typeof payload.webhookId === "string" && payload.webhookId.length > 0) {
      const row = await registryStore.findByWebhookId(payload.webhookId);
      if (row !== null) signingKey = row.signingKey;
    }
    if (signingKey === undefined) {
      signingKey = deps.secrets.getOptional("ALCHEMY_NOTIFY_SIGNING_KEY");
    }
    if (signingKey === undefined) {
      // No key resolvable. Return 404 (matches the strategy-not-configured
      // path earlier) so operators see a consistent "not set up" signal vs
      // the 401 reserved for bad signatures.
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Alchemy ingest not enabled" } }, 404);
    }

    const computedSig = bytesToHex(await hmacSha256(signingKey, rawBody));
    if (!constantTimeEqualHex(providedSig, computedSig)) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
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
