import type { EventBus } from "../../core/events/event-bus.port.js";
import type { Logger } from "../../core/ports/logger.port.js";
import { ALCHEMY_NETWORK_BY_CHAIN_ID } from "./alchemy-network.js";
import type { AlchemySubscriptionStore } from "./alchemy-subscription-store.js";

// Event-bus subscriber that translates domain events into Alchemy address-
// subscription queue rows:
//
//   order.created   -> insert (chainId, receiveAddress, action='add')
//   order.confirmed -> insert (chainId, receiveAddress, action='remove')
//   order.expired   -> insert (chainId, receiveAddress, action='remove')
//   order.canceled  -> insert (chainId, receiveAddress, action='remove')
//
// Chains Alchemy doesn't serve (dev chain 999, Tron, Solana) are skipped —
// they never get queued, so the sweep never sees them. That's why the tracker
// is coupled to Alchemy's supported-networks map, not general.
//
// We do NOT wait for the webhook registry to have a row before enqueueing.
// If an operator creates orders before bootstrapping the webhook, the rows
// just sit pending — the sweep picks them up once bootstrap runs. That's
// kinder than failing the order.

export interface AlchemySubscriptionTrackerConfig {
  events: EventBus;
  store: AlchemySubscriptionStore;
  logger: Logger;
  clock: { now(): Date };
}

export function registerAlchemySubscriptionTracker(
  config: AlchemySubscriptionTrackerConfig
): () => void {
  const { events, store, logger, clock } = config;

  const enqueue = async (chainId: number, address: string, action: "add" | "remove"): Promise<void> => {
    if (ALCHEMY_NETWORK_BY_CHAIN_ID[chainId] === undefined) return; // Chain not handled by Alchemy
    try {
      await store.insertPending({ chainId, address, action, now: clock.now().getTime() });
    } catch (err) {
      // Never rethrow out of the subscriber — the event bus handles errors,
      // and we don't want a DB hiccup here to fail order-create or terminal
      // transitions. Failing subscriptions are visible via the store's status
      // counts + admin listing (Phase 10+).
      logger.error("alchemy subscription enqueue failed", {
        chainId,
        address,
        action,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const unsubscribers = [
    events.subscribe("order.created", (event) => {
      void enqueue(event.order.chainId, event.order.receiveAddress, "add");
    }),
    events.subscribe("order.confirmed", (event) => {
      void enqueue(event.order.chainId, event.order.receiveAddress, "remove");
    }),
    events.subscribe("order.expired", (event) => {
      void enqueue(event.order.chainId, event.order.receiveAddress, "remove");
    }),
    events.subscribe("order.canceled", (event) => {
      void enqueue(event.order.chainId, event.order.receiveAddress, "remove");
    })
  ];

  return () => {
    for (const u of unsubscribers) u();
  };
}
