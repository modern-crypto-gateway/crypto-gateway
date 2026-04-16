// How webhook payloads reach the merchant's URL. Two implementations:
//   - inline-fetch.adapter  : do the fetch immediately (Workers friendly; ctx.waitUntil keeps it alive)
//   - queue-backed.adapter  : enqueue to CF Queues / BullMQ / SQS for retry/backoff/visibility
//
// The dispatcher is pure dispatch — it does NOT build the payload (that's
// webhook-composer in the domain) and does NOT sign it (signing is part of the
// payload shape). It DOES implement idempotent retry logic so the composer
// doesn't have to.

export interface WebhookDispatcher {
  dispatch(args: {
    url: string;
    payload: object;
    // HMAC secret for the outgoing X-Signature header. Supplied per-merchant.
    secret: string;
    // Caller-chosen deterministic key so the same event never re-delivers after retry.
    idempotencyKey: string;
  }): Promise<{
    delivered: boolean;
    statusCode?: number;
    // Human-readable failure reason when `delivered === false`.
    error?: string;
  }>;
}
