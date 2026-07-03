import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainFamily } from "../types/chain.js";
import { addressAllocations } from "../../db/schema.js";

// Append-only ownership-window history for receive addresses. Every pool
// allocate opens a window (released_at NULL); every release closes it. The
// re-ingest matcher reads these windows to attribute a transfer to the invoice
// that owned the address at the transfer's on-chain time. See the
// `address_allocations` table comment in db/schema.ts for the model.
//
// CRITICAL INVARIANT: each writer below MUST be stamped with the SAME clock
// read used for the corresponding address_pool / monero_subaddress_pool
// transition (allocated_at / last_released_at). A divergent or missed write
// leaves a window open/absent and silently mis-attributes. Every allocate and
// release path in pool.service / monero-pool.service / invoice.service calls
// into here.

export interface AllocationOpenInput {
  family: ChainFamily;
  // Canonical address (must match how detection canonicalizes toAddress).
  address: string;
  // Informational only (NULL for account families — match is chain-agnostic).
  chainId: number | null;
  // address_pool.id for account families; NULL for UTXO / Monero.
  poolAddressId: string | null;
  invoiceId: string;
  // The authoritative allocation instant (== the pool row's allocated_at).
  allocatedAt: number;
}

// Open a new ownership window. Called at every successful allocate/borrow/
// reacquire / fresh-derive.
export async function recordAllocationOpen(
  deps: AppDeps,
  input: AllocationOpenInput
): Promise<void> {
  await deps.db.insert(addressAllocations).values({
    id: globalThis.crypto.randomUUID(),
    family: input.family,
    address: input.address,
    chainId: input.chainId,
    poolAddressId: input.poolAddressId,
    invoiceId: input.invoiceId,
    allocatedAt: input.allocatedAt,
    releasedAt: null
  });
}

// Close every still-open window owned by `invoiceId`. The primary release path
// (releaseFromInvoice / releaseMoneroFromInvoice) keys by invoice because the
// pool UPDATE it mirrors also keys by allocated_to_invoice_id.
export async function closeAllocationsByInvoice(
  deps: AppDeps,
  invoiceId: string,
  releasedAt: number
): Promise<void> {
  await deps.db
    .update(addressAllocations)
    .set({ releasedAt })
    .where(
      and(eq(addressAllocations.invoiceId, invoiceId), isNull(addressAllocations.releasedAt))
    );
}

// Close still-open windows for a set of invoices (Monero leaked-allocation
// sweeper, which releases by pool row but whose history rows carry no
// pool_address_id, so we close by the released rows' invoice ids).
export async function closeAllocationsByInvoiceIds(
  deps: AppDeps,
  invoiceIds: readonly string[],
  releasedAt: number
): Promise<void> {
  if (invoiceIds.length === 0) return;
  await deps.db
    .update(addressAllocations)
    .set({ releasedAt })
    .where(
      and(
        inArray(addressAllocations.invoiceId, [...invoiceIds]),
        isNull(addressAllocations.releasedAt)
      )
    );
}

// Close still-open windows for a set of pool rows. Used by the account-family
// leaked-allocation sweeper, whose released rows may have a NULL invoice_id
// (broken state) — keying by pool_address_id is robust there.
export async function closeAllocationsByPoolIds(
  deps: AppDeps,
  poolAddressIds: readonly string[],
  releasedAt: number
): Promise<void> {
  if (poolAddressIds.length === 0) return;
  await deps.db
    .update(addressAllocations)
    .set({ releasedAt })
    .where(
      and(
        inArray(addressAllocations.poolAddressId, [...poolAddressIds]),
        isNull(addressAllocations.releasedAt)
      )
    );
}

// Close still-open windows for a set of addresses within a family. Used by the
// Monero leaked-allocation sweeper: its history rows carry no pool_address_id,
// and the sweeper's UPDATE...RETURNING yields the POST-update (nulled)
// invoice_id — but the address is unchanged, so we key on it.
export async function closeAllocationsByAddresses(
  deps: AppDeps,
  family: ChainFamily,
  addresses: readonly string[],
  releasedAt: number
): Promise<void> {
  if (addresses.length === 0) return;
  await deps.db
    .update(addressAllocations)
    .set({ releasedAt })
    .where(
      and(
        eq(addressAllocations.family, family),
        inArray(addressAllocations.address, [...addresses]),
        isNull(addressAllocations.releasedAt)
      )
    );
}
