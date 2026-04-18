import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { DomainEvent, DomainEventType } from "../events/event-bus.port.js";
import type {
  WebhookDeliveryRecord,
  WebhookResourceType
} from "../ports/webhook-delivery-store.port.js";
import { composeWebhook } from "./webhook-composer.js";
import { invoices, merchants, payouts } from "../../db/schema.js";

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

  const target = await resolveWebhookTarget(deps, composed.merchantId, composed.resource);
  if (!target) {
    // No webhook configured at any level (per-resource or merchant), or the
    // merchant is inactive. Silently skip — not an error.
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
    targetUrl: target.webhookUrl,
    // Snapshot the resource ref so the retry path can re-resolve via the same
    // precedence (resource → merchant). The URL is also snapshotted (above)
    // for human-readable audit; the secret is NOT snapshotted because the
    // resolver re-fetches it at retry time, letting merchant secret rotations
    // take effect mid-flight without any per-row plumbing.
    resourceType: composed.resource.type,
    resourceId: composed.resource.id,
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

// Exported so the sweeper can re-drive an existing row. Re-resolves the
// dispatch target with the same precedence used at insert time (per-resource
// webhook → merchant fallback), dispatches once, and records the outcome.
// Never throws — a dispatcher exception is recorded as a failure on the row.
export async function attemptDelivery(deps: AppDeps, deliveryId: string): Promise<void> {
  const row = await deps.webhookDeliveryStore.getById(deliveryId);
  if (row === null || row.status !== "pending") return;

  const resource =
    row.resourceType !== null && row.resourceId !== null
      ? { type: row.resourceType, id: row.resourceId }
      : null;
  const target = await resolveWebhookTarget(deps, row.merchantId, resource);
  if (!target) {
    // Merchant deactivated, or both per-resource and merchant webhook were
    // removed after the row was queued. Cannot retry — mark dead so the
    // sweeper doesn't keep picking it up.
    await deps.webhookDeliveryStore.markFailure({
      id: row.id,
      error: "no webhook target available (resource + merchant both unconfigured or merchant inactive)",
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
    secret = await deps.secretsCipher.decrypt(target.secretCiphertext);
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
      url: target.webhookUrl,
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

// Resolves the (URL, secret) pair to dispatch to. Precedence:
//   1. Per-resource webhook on the invoice/payout the event is about.
//   2. Merchant-account webhook fallback.
//   3. Skip — return undefined; the caller treats that as "no target".
//
// Merchant.active is checked unconditionally: a deactivated merchant stops
// receiving ANY webhooks regardless of per-resource overrides. Without that
// guard, deactivating a merchant wouldn't drain in-flight per-invoice
// deliveries. URL+secret are paired at every level — a row with one set and
// the other NULL is treated as "not configured at this level" so we don't
// dispatch with a mismatched HMAC key.
//
// Used by both the initial dispatch and the retry path so a merchant
// rotation between insert and retry takes effect on subsequent attempts.
async function resolveWebhookTarget(
  deps: AppDeps,
  merchantId: string,
  resource: { type: WebhookResourceType; id: string } | null
): Promise<{ webhookUrl: string; secretCiphertext: string } | undefined> {
  // Gate on merchant.active first — if the merchant is off, nothing dispatches.
  const [merchantRow] = await deps.db
    .select({
      webhookUrl: merchants.webhookUrl,
      webhookSecretCiphertext: merchants.webhookSecretCiphertext
    })
    .from(merchants)
    .where(and(eq(merchants.id, merchantId), eq(merchants.active, 1)))
    .limit(1);
  if (!merchantRow) return undefined;

  if (resource !== null) {
    const resourceTarget = await loadResourceWebhook(deps, resource);
    if (resourceTarget) return resourceTarget;
  }

  if (!merchantRow.webhookUrl || !merchantRow.webhookSecretCiphertext) return undefined;
  return {
    webhookUrl: merchantRow.webhookUrl,
    secretCiphertext: merchantRow.webhookSecretCiphertext
  };
}

async function loadResourceWebhook(
  deps: AppDeps,
  resource: { type: WebhookResourceType; id: string }
): Promise<{ webhookUrl: string; secretCiphertext: string } | undefined> {
  if (resource.type === "invoice") {
    const [row] = await deps.db
      .select({
        webhookUrl: invoices.webhookUrl,
        webhookSecretCiphertext: invoices.webhookSecretCiphertext
      })
      .from(invoices)
      .where(eq(invoices.id, resource.id))
      .limit(1);
    if (!row?.webhookUrl || !row.webhookSecretCiphertext) return undefined;
    return { webhookUrl: row.webhookUrl, secretCiphertext: row.webhookSecretCiphertext };
  }
  const [row] = await deps.db
    .select({
      webhookUrl: payouts.webhookUrl,
      webhookSecretCiphertext: payouts.webhookSecretCiphertext
    })
    .from(payouts)
    .where(eq(payouts.id, resource.id))
    .limit(1);
  if (!row?.webhookUrl || !row.webhookSecretCiphertext) return undefined;
  return { webhookUrl: row.webhookUrl, secretCiphertext: row.webhookSecretCiphertext };
}

// Exported for tests that need to assert against a single record.
export type { WebhookDeliveryRecord };
