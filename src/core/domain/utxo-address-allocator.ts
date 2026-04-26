import { sql } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import type { Address, ChainId } from "../types/chain.js";
import { addressIndexCounters } from "../../db/schema.js";

// UTXO families don't use the address_pool. Each invoice gets a brand-new
// HD-derived address from a per-chain monotonic counter. Privacy preserved
// (no reuse), schema simple (no pool reconciliation), BlockCypher hook
// lifecycle aligns 1:1 with the invoice. No cooldown, no quarantine, no
// reservation.
//
// Concurrency: the `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is one
// atomic statement. Two concurrent invoice creates serialize through it and
// land on distinct indices.
//
// Returned `addressIndex` is the SLOT this invoice owns — caller passes it
// to the chain adapter's deriveAddress. The seed lives on deps; this helper
// stays seed-free so it's pure DB logic.

export interface AllocatedUtxoAddress {
  readonly address: Address;
  readonly addressIndex: number;
}

export async function allocateUtxoAddress(
  deps: AppDeps,
  chainAdapter: ChainAdapter,
  chainId: ChainId,
  seed: string
): Promise<AllocatedUtxoAddress> {
  if (chainAdapter.family !== "utxo") {
    throw new Error(
      `allocateUtxoAddress: expected family='utxo', got '${chainAdapter.family}' for chainId=${chainId}`
    );
  }

  const now = deps.clock.now().getTime();
  // Atomic increment-and-return. The first call for a chain inserts row with
  // nextIndex=1 and returns 1; subsequent calls bump and return N+1. We then
  // use (returned - 1) as the slot for THIS invoice — i.e. the previous
  // value, which is what we wanted to claim.
  const [row] = await deps.db
    .insert(addressIndexCounters)
    .values({ chainId, nextIndex: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: addressIndexCounters.chainId,
      set: {
        nextIndex: sql`${addressIndexCounters.nextIndex} + 1`,
        updatedAt: now
      }
    })
    .returning({ nextIndex: addressIndexCounters.nextIndex });

  if (!row) {
    throw new Error(`allocateUtxoAddress: counter UPSERT returned no row (chainId=${chainId})`);
  }

  // Post-increment value − 1 = the slot we just reserved. The first invoice
  // gets index 0 (counter inserts at 1, we use 0); the second gets 1; etc.
  const addressIndex = row.nextIndex - 1;
  const { address } = chainAdapter.deriveAddress(seed, addressIndex);
  return { address, addressIndex };
}
