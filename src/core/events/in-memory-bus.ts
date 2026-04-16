import type { DomainEvent, DomainEventType, EventBus, EventHandler } from "./event-bus.port.js";

// Pure in-process implementation of the EventBus. Zero I/O, zero platform deps,
// so it lives in core rather than adapters. A future queue-backed bus (for
// cross-instance durability on Node deployments) would live in adapters/events/.
//
// Publish semantics: handlers run sequentially. If a handler throws, the error
// is caught and routed to `onHandlerError` (defaults to console.error). A
// failing handler MUST NOT block other handlers for the same event — they are
// independent concerns.

export interface InMemoryBusOptions {
  onHandlerError?: (err: unknown, eventType: DomainEventType) => void;
}

export function createInMemoryEventBus(opts: InMemoryBusOptions = {}): EventBus {
  const onError =
    opts.onHandlerError ??
    ((err, type) => {
      // core must not reference `console` without review — but console is a
      // browser/Node/Workers/Deno global, not a platform-specific one, so it
      // is allowed everywhere. The ESLint rule `no-console` warns on `.log`
      // only; `.error` is permitted.
      console.error(`[events] handler for "${type}" failed:`, err);
    });

  const typed = new Map<DomainEventType, Set<EventHandler>>();
  const wildcard = new Set<EventHandler>();

  return {
    async publish(event: DomainEvent) {
      const handlers = typed.get(event.type);
      if (handlers) {
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch (err) {
            onError(err, event.type);
          }
        }
      }
      for (const handler of wildcard) {
        try {
          await handler(event);
        } catch (err) {
          onError(err, event.type);
        }
      }
    },

    subscribe<T extends DomainEventType>(
      type: T,
      handler: EventHandler<Extract<DomainEvent, { type: T }>>
    ): () => void {
      let set = typed.get(type);
      if (!set) {
        set = new Set();
        typed.set(type, set);
      }
      const generic = handler as EventHandler;
      set.add(generic);
      return () => {
        set!.delete(generic);
      };
    },

    subscribeAll(handler: EventHandler): () => void {
      wildcard.add(handler);
      return () => {
        wildcard.delete(handler);
      };
    }
  };
}
