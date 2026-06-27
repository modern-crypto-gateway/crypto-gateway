import { describe, expect, it } from "vitest";
import { createInMemoryEventBus } from "../../core/events/in-memory-bus.js";
import { registerBlockcypherSubscriptionTracker } from "../../adapters/detection/blockcypher-subscription-tracker.js";
import type { BlockcypherSubscriptionStore } from "../../adapters/detection/blockcypher-subscription-store.js";
import type { Invoice } from "../../core/types/invoice.js";

// Regression test for the primary-family gap: multi-currency invoices carry a
// Litecoin leg as a SECONDARY family (the primary is whatever the invoice was
// created against, e.g. an EVM stablecoin). The tracker must subscribe EVERY
// UTXO receive address on the invoice, not just the primary one — otherwise
// BlockCypher never watches the LTC address and push detection never fires.

interface RecordedRow {
  chainId: number;
  coinPath: string;
  address: string;
  action: "subscribe" | "unsubscribe";
}

function fakeStore(): BlockcypherSubscriptionStore & { rows: RecordedRow[] } {
  const rows: RecordedRow[] = [];
  return {
    rows,
    async insertPending({ chainId, coinPath, address, action }) {
      rows.push({ chainId, coinPath, address, action });
      return "row-id";
    },
    async claimPending() {
      return [];
    },
    async markSynced() {},
    async markAttempted() {},
    async markFailed() {},
    // A prior synced subscribe exists, so unsubscribe rows get enqueued in tests.
    async findActiveHookId() {
      return "hook-123";
    },
    async countByStatus() {
      return { pending: 0, synced: 0, failed: 0 };
    }
  } as BlockcypherSubscriptionStore & { rows: RecordedRow[] };
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as Parameters<typeof registerBlockcypherSubscriptionTracker>[0]["logger"];

// Minimal Invoice with a primary EVM leg + a secondary Litecoin leg.
function multiFamilyInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv_1",
    chainId: 1, // primary = EVM (NOT litecoin)
    receiveAddress: "0xabc",
    receiveAddresses: [
      { family: "evm", chainId: 1, address: "0xabc", poolAddressId: null },
      { family: "utxo", chainId: 801, address: "ltc1qexampleaddr", poolAddressId: null }
    ],
    ...over
  } as unknown as Invoice;
}

function register(store: BlockcypherSubscriptionStore, configuredChainIds: Set<number>) {
  const events = createInMemoryEventBus();
  registerBlockcypherSubscriptionTracker({
    events,
    store,
    logger: noopLogger,
    clock: { now: () => new Date(1_700_000_000_000) },
    configuredChainIds
  });
  return events;
}

describe("blockcypher subscription tracker — multi-family", () => {
  it("subscribes the Litecoin leg even when LTC is a SECONDARY family", async () => {
    const store = fakeStore();
    const events = register(store, new Set([801]));

    await events.publish({
      type: "invoice.created",
      invoiceId: "inv_1" as never,
      invoice: multiFamilyInvoice(),
      at: new Date(1_700_000_000_000)
    });

    const subs = store.rows.filter((r) => r.action === "subscribe");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      chainId: 801,
      coinPath: "ltc/main",
      address: "ltc1qexampleaddr"
    });
  });

  it("skips non-UTXO legs and chains without BlockCypher config", async () => {
    const store = fakeStore();
    // Only bitcoin (800) configured — the LTC leg (801) must be dropped, and
    // the EVM leg (1) is non-UTXO so it's dropped too.
    const events = register(store, new Set([800]));

    await events.publish({
      type: "invoice.created",
      invoiceId: "inv_1" as never,
      invoice: multiFamilyInvoice(),
      at: new Date(1_700_000_000_000)
    });

    expect(store.rows).toHaveLength(0);
  });

  it("unsubscribes the Litecoin leg on invoice.expired", async () => {
    const store = fakeStore();
    const events = register(store, new Set([801]));

    await events.publish({
      type: "invoice.expired",
      invoiceId: "inv_1" as never,
      invoice: multiFamilyInvoice(),
      at: new Date(1_700_000_000_000)
    });

    const unsubs = store.rows.filter((r) => r.action === "unsubscribe");
    expect(unsubs).toHaveLength(1);
    expect(unsubs[0]).toMatchObject({ chainId: 801, address: "ltc1qexampleaddr" });
  });

  it("falls back to the primary address when receiveAddresses is absent", async () => {
    const store = fakeStore();
    const events = register(store, new Set([801]));

    // Older/partial payload: only the primary denormalized fields, and here
    // the primary IS litecoin.
    const legacy = {
      id: "inv_2",
      chainId: 801,
      receiveAddress: "ltc1qprimaryonly"
    } as unknown as Invoice;

    await events.publish({
      type: "invoice.created",
      invoiceId: "inv_2" as never,
      invoice: legacy,
      at: new Date(1_700_000_000_000)
    });

    const subs = store.rows.filter((r) => r.action === "subscribe");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ chainId: 801, address: "ltc1qprimaryonly" });
  });
});
