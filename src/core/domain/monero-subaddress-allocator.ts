import { sql } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { Address, ChainId } from "../types/chain.js";
import { moneroSubaddressCounters } from "../../db/schema.js";
import {
  deriveSubaddress,
  type MoneroNetwork
} from "../../adapters/chains/monero/monero-crypto.js";

// Monero subaddress allocator. Same atomic-counter shape as
// `allocateUtxoAddress`, but Monero subaddresses are derived under the
// gateway's single wallet rather than a per-chain HD path:
//
//   subaddress = deriveSubaddress(viewKey, primarySpendPub, account=0, index)
//
// Index 0/0 is the merchant's primary address — NOT a subaddress — so the
// counter starts at 1 and increments. The `monero_subaddress_counters` row
// for this chainId is bumped atomically; concurrent invoice creations land
// on distinct indices (UPSERT serializes them through the WAL).
//
// Returned `addressIndex` is what gets stored on
// `invoice_receive_addresses.address_index` so the operator's wallet can
// find the same subaddress when reconciling on their end.

export interface AllocatedMoneroSubaddress {
  readonly address: Address;
  readonly addressIndex: number;
}

/**
 * @deprecated Monero invoices now allocate from the reusable subaddress pool
 * (`monero-pool.service.ts`, allocateMoneroFromPool) instead of minting a fresh
 * subaddress per invoice. This monotonic allocator is no longer on the
 * invoice-create path. The `monero_subaddress_counters` table it maintains is
 * retained as the pool's index high-water mark (the pool seeds at or above
 * `next_index` and bumps it forward), so neither this function nor the table
 * should be removed without migrating that responsibility.
 */
export async function allocateMoneroSubaddress(args: {
  deps: AppDeps;
  chainId: ChainId;
  network: MoneroNetwork;
  viewKey: Uint8Array;
  primarySpendPub: Uint8Array;
}): Promise<AllocatedMoneroSubaddress> {
  const { deps, chainId, network, viewKey, primarySpendPub } = args;
  const now = deps.clock.now().getTime();

  // Atomic increment-and-return. First call inserts (chainId, next=2) and
  // returns 2; subsequent calls bump and return N+1. Use (returned - 1) as
  // the slot for THIS invoice. That gives 1, 2, 3, … — index 0 is the
  // primary address (never used for invoice receive).
  const [row] = await deps.db
    .insert(moneroSubaddressCounters)
    .values({ chainId, nextIndex: 2, updatedAt: now })
    .onConflictDoUpdate({
      target: moneroSubaddressCounters.chainId,
      set: {
        nextIndex: sql`${moneroSubaddressCounters.nextIndex} + 1`,
        updatedAt: now
      }
    })
    .returning({ nextIndex: moneroSubaddressCounters.nextIndex });

  if (!row) {
    throw new Error(
      `allocateMoneroSubaddress: counter UPSERT returned no row (chainId=${chainId})`
    );
  }

  const addressIndex = row.nextIndex - 1;
  const address = deriveSubaddress({
    network,
    viewKeySecret: viewKey,
    primarySpendPub,
    account: 0,
    index: addressIndex
  });
  return { address: address as Address, addressIndex };
}
