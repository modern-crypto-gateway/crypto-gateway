import type { WebhookDispatcher } from "../../core/ports/webhook-delivery.port.ts";

// Discards all dispatches. Used for Phase 2 boot and unit tests where we don't
// care about downstream delivery. Phase 4 introduces inline-fetch.adapter for
// real HTTP delivery.

export function noopWebhookDispatcher(): WebhookDispatcher {
  return {
    async dispatch() {
      return { delivered: true };
    }
  };
}

// Capturing variant for tests: records every dispatch call so assertions can
// verify the right webhook was built. `calls` is shared, reads are synchronous.
export interface CapturingDispatcher extends WebhookDispatcher {
  calls: Array<{ url: string; payload: object; secret: string; idempotencyKey: string }>;
  reset(): void;
}

export function capturingWebhookDispatcher(): CapturingDispatcher {
  const calls: CapturingDispatcher["calls"] = [];
  return {
    calls,
    reset() {
      calls.length = 0;
    },
    async dispatch(args) {
      calls.push({ ...args });
      return { delivered: true, statusCode: 200 };
    }
  };
}
