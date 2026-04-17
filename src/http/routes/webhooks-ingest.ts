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
//   4. Resolve the HMAC signing key by `webhookId` from the encrypted-at-rest
//      `alchemy_webhook_registry`. Populated by bootstrap, or manually via
//      `POST /admin/alchemy-webhooks/signing-keys` for dashboard-created webhooks.
//   5. Verify HMAC-SHA256 in constant time against the resolved key
//   6. Hand parsed payload to the DetectionStrategy and ingest transfers
//
// We intentionally do NOT return details about why a verification failed — a
// blanket 401 denies an attacker a probing oracle.

// Size cap on the raw body. Alchemy ADDRESS_ACTIVITY payloads are typically
// < 10 KB even for bursty blocks; 64 KB gives comfortable headroom without
// opening a JSON-parse DoS vector.
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

// Replay-window: reject payloads whose `createdAt` is older than this. Alchemy
// retries on non-2xx for ~5 attempts over a few minutes, so 10 minutes is a
// generous freshness window that still defangs captured-and-replayed payloads.
const MAX_PAYLOAD_AGE_MS = 10 * 60 * 1000;

// Dedup TTL for a seen payload `id`. Must be ≥ MAX_PAYLOAD_AGE_MS so a payload
// that's still inside the freshness window can't be replayed by an attacker who
// times their replay just outside the dedup TTL but inside the freshness check.
const REPLAY_CACHE_TTL_SECONDS = 24 * 60 * 60;

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
      keyFn: (c) => getClientIp(c, deps.rateLimits.trustedIpHeaders),
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

    // Pre-parse Content-Length guard so we 413 BEFORE buffering a large
    // body into memory. The post-read length check below is the authoritative
    // check (a malicious peer can lie about Content-Length), but rejecting at
    // the header level is much cheaper and covers honest oversize requests.
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, 413);
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
    let payload: { webhookId?: string; id?: string; createdAt?: string } & Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: { code: "BAD_JSON" } }, 400);
    }

    // Replay defense, pre-HMAC: an attacker who captures a previously-valid
    // payload can re-POST it with the original signature and have it verify
    // every time. Two complementary checks:
    //
    //   1. Freshness: reject anything whose `createdAt` is outside the replay
    //      window. Caps how stale a captured payload can be when reused.
    //   2. Nonce: cache `id` for ≥ the freshness window. The first POST
    //      processes; subsequent POSTs with the same id 200 with seen=true.
    //
    // Both checks happen pre-HMAC so they protect the verify path itself
    // from being a probing oracle. Payloads that lack `id`/`createdAt` skip
    // the corresponding check (forward-compat with payload schema changes).
    const nowMs = deps.clock.now().getTime();
    if (typeof payload.createdAt === "string") {
      const createdMs = Date.parse(payload.createdAt);
      if (Number.isFinite(createdMs) && nowMs - createdMs > MAX_PAYLOAD_AGE_MS) {
        deps.logger.warn("webhook payload rejected: stale createdAt", {
          webhookId: payload.webhookId,
          payloadId: payload.id,
          ageMs: nowMs - createdMs
        });
        return c.json({ error: { code: "STALE_PAYLOAD" } }, 401);
      }
    }
    if (typeof payload.id === "string" && payload.id.length > 0) {
      // putIfAbsent returns false on contention (someone already saw this id).
      // Backend semantics: memory = strict, KV = eventually consistent so a
      // racing duplicate inside the KV propagation window may slip through;
      // the downstream INSERT into `transactions` then trips its UNIQUE
      // constraint and ingestDetectedTransfer treats it as a no-op.
      const acquired = await deps.cache.putIfAbsent(
        `webhook:alchemy:seen:${payload.id}`,
        "1",
        { ttlSeconds: REPLAY_CACHE_TTL_SECONDS }
      );
      if (!acquired) {
        deps.logger.info("webhook payload deduped (already seen)", {
          webhookId: payload.webhookId,
          payloadId: payload.id
        });
        // 200 so the provider doesn't spin up a retry loop on a payload we've
        // already accepted. `received: true, deduped: true` is the contract.
        return c.json({ received: true, deduped: true }, 200);
      }
    }

    // Resolve the signing key via the DB registry keyed on webhookId. The DB
    // is the only source of truth — bootstrap persists keys at creation time,
    // and dashboard-created webhooks register via the manual admin endpoint.
    // There used to be an `ALCHEMY_NOTIFY_SIGNING_KEY` env fallback; it was
    // removed because a single env var can't serve multi-chain deployments.
    const registryStore = dbAlchemyRegistryStore(deps.db);
    let signingKey: string | undefined;
    if (typeof payload.webhookId === "string" && payload.webhookId.length > 0) {
      const row = await registryStore.findByWebhookId(payload.webhookId);
      if (row !== null) {
        // Stored ciphertext -> plaintext HMAC key, on demand. Any decryption
        // failure here means the row is corrupt or the SECRETS_ENCRYPTION_KEY
        // was rotated without re-encrypting; treat as "not configured" so a
        // sane 404 beats a 500 to the provider's retry loop.
        try {
          signingKey = await deps.secretsCipher.decrypt(row.signingKeyCiphertext);
        } catch (err) {
          deps.logger.error("alchemy registry signing key could not be decrypted", {
            webhookId: payload.webhookId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
    if (signingKey === undefined) {
      // No registry row for this webhookId. 404 matches the
      // strategy-not-configured path above so operators see "not set up"
      // consistently; real bad signatures get 401.
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
