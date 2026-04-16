import type { AppDeps } from "../app-deps.js";
import type { DomainEvent, DomainEventType } from "../events/event-bus.port.js";
import { composeWebhook } from "./webhook-composer.js";

// Subscribes to domain events and dispatches composed webhooks. Called once
// per AppDeps from buildApp — the subscriptions stay active for the lifetime
// of the app.
//
// Design notes:
//   - Dispatch is handed to `deps.jobs.defer` so the HTTP request generating
//     the event isn't blocked on the merchant's server. On Workers this
//     forwards to ctx.waitUntil; on Node the promise-set runner keeps it alive.
//   - Merchant lookup happens at dispatch time (not subscribe time) so admin
//     updates to webhook URL / secret take effect immediately for subsequent events.
//   - Merchants with webhook_url = NULL silently skip: the gateway treats
//     webhooks as opt-in.

// Events that reach merchants — matches the union returned by composeWebhook.
const OUTBOUND_EVENT_TYPES = [
  "order.partial",
  "order.detected",
  "order.confirmed",
  "order.expired",
  "order.canceled",
  "payout.submitted",
  "payout.confirmed",
  "payout.failed"
] as const satisfies readonly DomainEventType[];

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

  const merchant = await deps.db
    .prepare(
      "SELECT webhook_url, webhook_secret_ciphertext FROM merchants WHERE id = ? AND active = 1"
    )
    .bind(composed.merchantId)
    .first<{ webhook_url: string | null; webhook_secret_ciphertext: string | null }>();

  if (!merchant?.webhook_url || !merchant.webhook_secret_ciphertext) {
    // Merchant has not configured webhooks (or is inactive). Not an error.
    return;
  }

  // The secret is stored encrypted at rest (AES-GCM via secretsCipher). We
  // decrypt only to HMAC the outgoing body and throw away the plaintext
  // immediately — no secret should outlive this function's stack frame.
  const secret = await deps.secretsCipher.decrypt(merchant.webhook_secret_ciphertext);

  await deps.webhookDispatcher.dispatch({
    url: merchant.webhook_url,
    payload: composed.payload,
    secret,
    idempotencyKey: composed.idempotencyKey
  });
}
