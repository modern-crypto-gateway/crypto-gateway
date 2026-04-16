import type { WebhookDispatcher } from "../../core/ports/webhook-delivery.port.ts";
import { bytesToHex, hmacSha256 } from "../crypto/subtle.js";

export interface InlineFetchDispatcherConfig {
  // Injectable fetch for tests / Workers. Defaults to globalThis.fetch.
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  // Per-request timeout in ms. Defaults to 10s.
  timeoutMs?: number;
  // Total delivery attempts (initial + retries). Defaults to 4.
  maxAttempts?: number;
  // Base for exponential backoff in ms between attempts. Defaults to 250ms
  // (so attempts land at ~250ms, ~500ms, ~1s).
  retryBaseMs?: number;
  // Statuses that trigger a retry rather than a permanent failure.
  // Defaults to 408, 425, 429, and anything in 5xx.
  retryOn?: (status: number) => boolean;
}

// Signs + POSTs the JSON payload to the merchant's URL with HMAC-SHA256 of the
// raw body over the shared secret. Exposed headers:
//   Content-Type:        application/json
//   X-Webhook-Signature: hex-encoded HMAC-SHA256 of the raw body
//   X-Webhook-Idempotency-Key: value provided by caller; stable across retries
//   X-Webhook-Timestamp:  unix-millis of the first attempt (stable across retries)
//
// The dispatcher does its own retry loop with exponential backoff — the
// JobRunner (waitUntil on Workers, promise-set on Node) keeps it alive while
// we retry.

export function inlineFetchDispatcher(config: InlineFetchDispatcherConfig = {}): WebhookDispatcher {
  const doFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxAttempts = config.maxAttempts ?? 4;
  const retryBaseMs = config.retryBaseMs ?? 250;
  const shouldRetry =
    config.retryOn ?? ((status: number) => status === 408 || status === 425 || status === 429 || status >= 500);

  return {
    async dispatch({ url, payload, secret, idempotencyKey }) {
      const body = JSON.stringify(payload);
      const sigBytes = await hmacSha256(secret, body);
      const signature = bytesToHex(sigBytes);
      const firstAttemptTs = Date.now().toString();

      let lastStatus: number | undefined;
      let lastError: string | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await withTimeout(
            doFetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-webhook-signature": signature,
                "x-webhook-idempotency-key": idempotencyKey,
                "x-webhook-timestamp": firstAttemptTs,
                "x-webhook-attempt": attempt.toString()
              },
              body
            }),
            timeoutMs
          );
          lastStatus = res.status;
          if (res.ok) {
            return { delivered: true, statusCode: res.status };
          }
          if (!shouldRetry(res.status)) {
            // 4xx (except retryable) -> permanent failure; don't burn retry budget.
            return {
              delivered: false,
              statusCode: res.status,
              error: `HTTP ${res.status} (non-retryable)`
            };
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }

        if (attempt < maxAttempts) {
          await sleep(retryBaseMs * 2 ** (attempt - 1));
        }
      }

      const result: { delivered: boolean; statusCode?: number; error?: string } = { delivered: false };
      if (lastStatus !== undefined) result.statusCode = lastStatus;
      result.error = lastError ?? `HTTP ${lastStatus ?? "unknown"} after ${maxAttempts} attempts`;
      return result;
    }
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`webhook fetch timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
