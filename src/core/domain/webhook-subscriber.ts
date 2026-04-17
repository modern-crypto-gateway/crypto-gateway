import type { AppDeps } from "../app-deps.js";
import type { DomainEvent, DomainEventType } from "../events/event-bus.port.js";
import type { WebhookDeliveryRecord } from "../ports/webhook-delivery-store.port.js";
import { composeWebhook } from "./webhook-composer.js";

// Subscribes to domain events and dispatches composed webhooks. Called once
// per AppDeps from buildApp — the subscriptions stay active for the lifetime
// of the app.
//
// Delivery flow (outbox pattern):
//   1. Event arrives on the bus.
//   2. We compose the payload, look up the merchant, and INSERT OR IGNORE
//      a row into `webhook_deliveries` with a stable idempotency_key. A
//      duplicate key means the same logical event already has a row; we skip.
//   3. We dispatch. On success the row goes 'delivered'. On failure we bump
//      next_attempt_at (exponential backoff) or mark 'dead' once we exhaust
//      MAX_OUTER_ATTEMPTS.
//   4. The scheduled-jobs sweeper (sweepWebhookDeliveries) re-dispatches any
//      'pending' row whose next_attempt_at has passed — this is the safety
//      net for process crashes between dispatch and the row update.
//
// The whole thing runs inside deps.jobs.defer so the synchronous publisher
// (state machine transition) is not blocked on the merchant's server.

// Events that reach merchants — matches the union returned by composeWebhook.
const OUTBOUND_EVENT_TYPES = [
  "invoice.partial",
  "invoice.detected",
  "invoice.confirmed",
  "invoice.overpaid",
  "invoice.expired",
  "invoice.canceled",
  "invoice.demoted",
  "invoice.payment_received",
  "payout.submitted",
  "payout.confirmed",
  "payout.failed"
] as const satisfies readonly DomainEventType[];

// Outer-attempt cap. Each outer attempt delegates to the dispatcher which
// itself performs up to `maxAttempts` (default 4) inline retries with short
// backoff. So MAX_OUTER_ATTEMPTS=5 means up to 20 HTTP attempts against the
// merchant before we give up permanently — matches industry norms for a
// best-effort webhook delivery system.
const MAX_OUTER_ATTEMPTS = 5;

// Backoff schedule between outer attempts, in ms. Indexed by next attempt
// number (so BACKOFF_MS[1] is the delay between attempt 1 and attempt 2).
// Attempt 0 is reserved: the initial dispatch runs at insert time with no
// wait. Past the table length the schedule caps at the last value.
const BACKOFF_MS: readonly number[] = [
  0,
  5 * 60 * 1000,   // 5 min
  15 * 60 * 1000,  // 15 min
  60 * 60 * 1000,  // 1 hr
  6 * 60 * 60 * 1000 // 6 hr
];

export function registerWebhookSubscriber(deps: AppDeps): () => void {
  const unsubscribers = OUTBOUND_EVENT_TYPES.map((type) =>
    deps.events.subscribe(type, (event) => {
      // NOTE: we don't await here — the handler returns void; the dispatch
      // itself is deferred via deps.jobs. That keeps synchronous publishers
      // (state machine transitions) fast.
      deps.jobs.defer(() => dispatchEvent(deps, event), { name: `webhook:${event.type}` });
    })
  );

  return () => {
    for (const u of unsubscribers) u();
  };
}

async function dispatchEvent(deps: AppDeps, event: DomainEvent): Promise<void> {
  const composed = composeWebhook(event);
  if (!composed) return;

  const merchant = await loadMerchantWebhook(deps, composed.merchantId);
  if (!merchant) {
    // Merchant has not configured webhooks (or is inactive). Not an error.
    return;
  }

  const id = globalThis.crypto.randomUUID();
  const now = deps.clock.now().getTime();
  const { inserted } = await deps.webhookDeliveryStore.insertPending({
    id,
    merchantId: composed.merchantId,
    eventType: composed.payload.event,
    idempotencyKey: composed.idempotencyKey,
    payload: composed.payload as unknown as Record<string, unknown>,
    targetUrl: merchant.webhookUrl,
    nextAttemptAt: now,
    now
  });

  if (!inserted) {
    // Duplicate idempotency key: this event already has a delivery row from
    // a prior publish (bus replay, poll re-detection). The existing row is
    // either in-flight, delivered, or will be picked up by the sweeper. Do
    // not create a parallel dispatch.
    return;
  }

  await attemptDelivery(deps, id);
}

// Exported so the sweeper can re-drive an existing row. Looks up the current
// row + merchant state, dispatches once, and records the outcome. Never
// throws — a dispatcher exception is recorded as a failure on the row.
export async function attemptDelivery(deps: AppDeps, deliveryId: string): Promise<void> {
  const row = await deps.webhookDeliveryStore.getById(deliveryId);
  if (row === null || row.status !== "pending") return;

  const merchant = await loadMerchantWebhook(deps, row.merchantId);
  if (!merchant) {
    // Merchant deactivated or had their webhook removed after the row was
    // queued. Cannot retry — mark dead so the sweeper doesn't keep picking it up.
    await deps.webhookDeliveryStore.markFailure({
      id: row.id,
      error: "merchant inactive or webhook not configured",
      nextAttemptAt: null,
      now: deps.clock.now().getTime()
    });
    return;
  }

  // The secret is stored encrypted at rest (AES-GCM via secretsCipher). We
  // decrypt only to HMAC the outgoing body and throw away the plaintext
  // immediately — no secret should outlive this function's stack frame.
  let secret: string;
  try {
    secret = await deps.secretsCipher.decrypt(merchant.secretCiphertext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.webhookDeliveryStore.markFailure({
      id: row.id,
      error: `secret decrypt failed: ${msg}`,
      nextAttemptAt: null,
      now: deps.clock.now().getTime()
    });
    return;
  }

  let result: { delivered: boolean; statusCode?: number; error?: string };
  try {
    result = await deps.webhookDispatcher.dispatch({
      url: merchant.webhookUrl,
      payload: row.payload,
      secret,
      idempotencyKey: row.idempotencyKey
    });
  } catch (err) {
    result = {
      delivered: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const now = deps.clock.now().getTime();
  if (result.delivered) {
    await deps.webhookDeliveryStore.markDelivered({
      id: row.id,
      statusCode: result.statusCode ?? 200,
      now
    });
    return;
  }

  const nextAttemptNumber = row.attempts + 1;
  const isTerminal = nextAttemptNumber >= MAX_OUTER_ATTEMPTS;
  const nextAttemptAt = isTerminal
    ? null
    : now + (BACKOFF_MS[nextAttemptNumber] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0);

  const failureArgs: Parameters<typeof deps.webhookDeliveryStore.markFailure>[0] = {
    id: row.id,
    error: result.error ?? "unknown dispatch failure",
    nextAttemptAt,
    now,
    ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {})
  };
  await deps.webhookDeliveryStore.markFailure(failureArgs);

  if (isTerminal) {
    deps.logger.error("webhook delivery permanently failed", {
      deliveryId: row.id,
      merchantId: row.merchantId,
      eventType: row.eventType,
      attempts: nextAttemptNumber,
      lastError: failureArgs.error
    });
  }
}

// Sweeper: called from runScheduledJobs. Pulls every 'pending' row whose
// next_attempt_at has passed and re-drives it through attemptDelivery.
// Limits the batch per tick so a large backlog can't stall the scheduled-jobs
// runner — the remainder gets picked up on the next tick.
export async function sweepWebhookDeliveries(
  deps: AppDeps,
  opts: { limit?: number } = {}
): Promise<{ attempted: number }> {
  const limit = opts.limit ?? 100;
  const now = deps.clock.now().getTime();
  const due = await deps.webhookDeliveryStore.listDueForRetry({ now, limit });
  for (const row of due) {
    await attemptDelivery(deps, row.id);
  }
  return { attempted: due.length };
}

// Internal merchant lookup. Returns undefined when the merchant is inactive
// or has not configured webhooks. Factored out so the subscriber and the
// retry path share identical rules — a merchant that deactivates between
// the insert and the retry correctly stops receiving events.
async function loadMerchantWebhook(
  deps: AppDeps,
  merchantId: string
): Promise<{ webhookUrl: string; secretCiphertext: string } | undefined> {
  const row = await deps.db
    .prepare(
      "SELECT webhook_url, webhook_secret_ciphertext FROM merchants WHERE id = ? AND active = 1"
    )
    .bind(merchantId)
    .first<{ webhook_url: string | null; webhook_secret_ciphertext: string | null }>();
  if (!row?.webhook_url || !row.webhook_secret_ciphertext) return undefined;
  return { webhookUrl: row.webhook_url, secretCiphertext: row.webhook_secret_ciphertext };
}

// Exported for tests that need to assert against a single record.
export type { WebhookDeliveryRecord };
