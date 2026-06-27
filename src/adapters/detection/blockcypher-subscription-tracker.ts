import type { EventBus } from "../../core/events/event-bus.port.js";
import type { Logger } from "../../core/ports/logger.port.js";
import type { Invoice } from "../../core/types/invoice.js";
import { utxoConfigForChainId } from "../chains/utxo/utxo-config.js";
import type { BlockcypherSubscriptionStore } from "./blockcypher-subscription-store.js";

// Event-bus subscriber that translates UTXO invoice lifecycle events into
// per-address BlockCypher hook operations:
//
//   invoice.created           → 'subscribe' row for EACH UTXO receive address on
//                                the invoice (push notifications per address)
//   invoice.completed         → 'unsubscribe' row per address (free the hook
//                                quota slot; BlockCypher free tier caps ~200)
//   invoice.expired           → 'unsubscribe'
//   invoice.canceled          → 'unsubscribe'
//
// IMPORTANT: we walk `invoice.receiveAddresses[]`, not just the primary
// `invoice.receiveAddress`. A multi-currency invoice carries one address per
// accepted family, and the Litecoin (UTXO) leg is frequently a SECONDARY
// family — the primary is whatever currency the invoice was created against
// (e.g. an EVM stablecoin). Subscribing only the primary silently skipped LTC
// hooks for those invoices, so BlockCypher never watched the LTC address and
// push detection never fired. enqueueSubscribe/enqueueUnsubscribe filter out
// non-UTXO and unconfigured chains, so passing the whole list is safe.
//
// Differs from the Alchemy tracker in two ways:
//   1. Lifecycle is invoice-scoped, not pool-scoped (UTXO has no pool —
//      each invoice has its own one-shot address that's never reused).
//   2. Per-event idempotency: if multiple terminal transitions fire for the
//      same invoice (rare but possible during retries), the sweeper handles
//      duplicate `unsubscribe` rows by treating BlockCypher's 404 as success.
//
// Non-utxo-family invoices are ignored cleanly — the tracker filters on
// chainId via `utxoConfigForChainId`.

export interface BlockcypherSubscriptionTrackerConfig {
  events: EventBus;
  store: BlockcypherSubscriptionStore;
  logger: Logger;
  clock: { now(): Date };
  // Set of chainIds that have a complete BlockCypher config
  // (BLOCKCYPHER_TOKEN_<SLUG> + BLOCKCYPHER_CALLBACK_URL_<SLUG>). Events for
  // chainIds not in this set are dropped at enqueue time so rows for chains
  // without an active config don't pile up unsynced. Sourced from
  // `deps.blockcypher.configuredChainIds` at registration time. An empty
  // set is valid — every event is a no-op (entrypoint should normally not
  // construct deps.blockcypher in that case, but defending here keeps the
  // tracker safe to mount unconditionally).
  configuredChainIds: ReadonlySet<number>;
}

export function registerBlockcypherSubscriptionTracker(
  config: BlockcypherSubscriptionTrackerConfig
): () => void {
  const { events, store, logger, clock, configuredChainIds } = config;

  const enqueueSubscribe = async (
    chainId: number,
    address: string
  ): Promise<void> => {
    const cfg = utxoConfigForChainId(chainId);
    if (cfg === null) return; // not a utxo chain → no-op
    if (cfg.blockcypherCoinPath === null) return; // chain not on BlockCypher (e.g. LTC testnet)
    if (!configuredChainIds.has(chainId)) return; // env config absent for this chain
    try {
      await store.insertPending({
        chainId,
        coinPath: cfg.blockcypherCoinPath,
        address: address.toLowerCase(),
        action: "subscribe",
        hookId: null,
        now: clock.now().getTime()
      });
    } catch (err) {
      logger.error("blockcypher subscription enqueue failed", {
        chainId,
        address,
        action: "subscribe",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const enqueueUnsubscribe = async (
    chainId: number,
    address: string
  ): Promise<void> => {
    const cfg = utxoConfigForChainId(chainId);
    if (cfg === null) return;
    if (cfg.blockcypherCoinPath === null) return;
    if (!configuredChainIds.has(chainId)) return;
    const hookId = await store.findActiveHookId(chainId, address.toLowerCase()).catch(() => null);
    if (hookId === null) {
      logger.debug("blockcypher unsubscribe skipped — no active hookId", {
        chainId,
        address
      });
      return;
    }
    try {
      await store.insertPending({
        chainId,
        coinPath: cfg.blockcypherCoinPath,
        address: address.toLowerCase(),
        action: "unsubscribe",
        hookId,
        now: clock.now().getTime()
      });
    } catch (err) {
      logger.error("blockcypher subscription enqueue failed", {
        chainId,
        address,
        action: "unsubscribe",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  // Every receive address on the invoice that BlockCypher should consider.
  // Prefer the authoritative multi-family `receiveAddresses[]`; fall back to
  // the primary denormalized fields only if it's absent (defensive — the
  // Invoice type always populates receiveAddresses today).
  const receiveTargets = (
    invoice: Invoice
  ): ReadonlyArray<{ chainId: number; address: string }> => {
    const list = invoice.receiveAddresses;
    if (Array.isArray(list) && list.length > 0) {
      return list.map((rx) => ({ chainId: rx.chainId, address: rx.address }));
    }
    return [{ chainId: invoice.chainId, address: invoice.receiveAddress }];
  };

  const unsubscribers = [
    events.subscribe("invoice.created", async (event) => {
      for (const t of receiveTargets(event.invoice)) {
        await enqueueSubscribe(t.chainId, t.address);
      }
    }),
    events.subscribe("invoice.completed", async (event) => {
      for (const t of receiveTargets(event.invoice)) {
        await enqueueUnsubscribe(t.chainId, t.address);
      }
    }),
    events.subscribe("invoice.expired", async (event) => {
      for (const t of receiveTargets(event.invoice)) {
        await enqueueUnsubscribe(t.chainId, t.address);
      }
    }),
    events.subscribe("invoice.canceled", async (event) => {
      for (const t of receiveTargets(event.invoice)) {
        await enqueueUnsubscribe(t.chainId, t.address);
      }
    })
  ];

  return () => {
    for (const u of unsubscribers) u();
  };
}
