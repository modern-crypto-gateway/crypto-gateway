import type { ChainFamily } from "../../core/types/chain.js";
import type { EventBus } from "../../core/events/event-bus.port.js";
import type { Logger } from "../../core/ports/logger.port.js";
import { ALCHEMY_FAMILY_BY_CHAIN_ID } from "./alchemy-network.js";
import type { AlchemySubscriptionStore } from "./alchemy-subscription-store.js";

// Event-bus subscriber that translates POOL events into per-chain Alchemy
// address-subscription queue rows:
//
//   pool.address.created     -> one 'add' row per Alchemy-served chain in family
//   pool.address.quarantined -> one 'remove' row per Alchemy-served chain in family
//
// Lifecycle is now tied to the POOL, not individual invoices. A pool row
// reused across 1000 invoices stays subscribed the whole time. Invoices
// reaching terminal states do NOT trigger subscription removes — the address
// is still watchable and might serve the next invoice.
//
// Fan-out: one EVM pool address emits `add` for 7 chainIds (ETH/OP/Polygon/
// Base/Arbitrum/AVAX/BSC). One Solana pool address emits one row for
// chainId 900. Tron family emits zero rows (Alchemy doesn't do Tron webhooks).
//
// `alchemyChainsByFamily` is supplied by the entrypoint and reflects the
// active `ALCHEMY_CHAINS` env slice — an operator running only ETH+Polygon
// would pass `{ evm: [1, 137], solana: [900] }`, so that's the only fan-out
// the tracker performs.

export interface AlchemySubscriptionTrackerConfig {
  events: EventBus;
  store: AlchemySubscriptionStore;
  logger: Logger;
  clock: { now(): Date };
  // Per-family list of chainIds to subscribe when a pool address arrives.
  // Typically derived from the operator's active Alchemy chain set.
  alchemyChainsByFamily: Readonly<Partial<Record<ChainFamily, readonly number[]>>>;
}

export function registerAlchemySubscriptionTracker(
  config: AlchemySubscriptionTrackerConfig
): () => void {
  const { events, store, logger, clock, alchemyChainsByFamily } = config;

  const enqueue = async (
    chainId: number,
    address: string,
    action: "add" | "remove"
  ): Promise<void> => {
    // Extra defensive — only enqueue for chains Alchemy actually serves.
    // The caller supplies the chain list, but we double-check so a
    // misconfigured deployment can't produce ingest rows for chains Alchemy
    // rejects at sync time.
    if (ALCHEMY_FAMILY_BY_CHAIN_ID[chainId] === undefined) return;
    try {
      await store.insertPending({ chainId, address, action, now: clock.now().getTime() });
    } catch (err) {
      logger.error("alchemy subscription enqueue failed", {
        chainId,
        address,
        action,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const unsubscribers = [
    events.subscribe("pool.address.created", async (event) => {
      const chains = alchemyChainsByFamily[event.family] ?? [];
      for (const chainId of chains) {
        await enqueue(chainId, event.address, "add");
      }
    }),
    events.subscribe("pool.address.quarantined", async (event) => {
      const chains = alchemyChainsByFamily[event.family] ?? [];
      for (const chainId of chains) {
        await enqueue(chainId, event.address, "remove");
      }
    })
  ];

  return () => {
    for (const u of unsubscribers) u();
  };
}
