import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainId } from "../types/chain.js";
import {
  addressIndexCounters,
  invoiceReceiveAddresses,
  utxos
} from "../../db/schema.js";

// One-shot repair for the multi-family UTXO `address_index` bug fixed in
// migration 0006.
//
// Pre-fix detection ingest stamped `utxos.address_index` with the value
// from `invoices.address_index` (the legacy primary-family-only column).
// For multi-family universal invoices where UTXO was non-primary, that
// value was the EVM/Tron/Solana primary's index — completely unrelated
// to the BTC/LTC counter index that minted the actual receive address.
// Migration 0006 backfilled `invoice_receive_addresses.address_index`
// from the same wrong source for those rows; this script corrects them
// by deriving every counter slot from MASTER_SEED and matching against
// each row's `address`.
//
// What it does, per UTXO chain registered on `deps.chains`:
//   1. Read the chain's counter (`address_index_counters.next_index`) →
//      upper bound on indices ever minted.
//   2. Derive `(address → index)` for every slot 0..next_index−1.
//   3. For every `invoice_receive_addresses` row on that chain whose
//      `address_index` doesn't match the derived value: UPDATE.
//   4. For every `utxos` row on that chain whose `address_index` doesn't
//      match: UPDATE. The row's `address` field is the canonical
//      lowercase bech32 we derived in step 2.
//
// Idempotent: re-running after a successful repair is a no-op (every
// row's index already matches the derived value, no UPDATE fires).
//
// Returns a per-chain report so the operator can verify the scope of
// changes before re-attempting any failed payouts.

export interface ChainRepairReport {
  readonly chainId: number;
  readonly counterValue: number;
  readonly invoiceRxScanned: number;
  readonly invoiceRxFixed: number;
  readonly utxosScanned: number;
  readonly utxosFixed: number;
  // Set when the chain has rows we couldn't match — usually a sign the
  // counter advanced past where the seed currently produces these
  // addresses (different MASTER_SEED than at minting time). Lists the
  // unmatched addresses so the operator can investigate.
  readonly unmatchedAddresses: readonly string[];
}

export interface UtxoAddressIndexRepairResult {
  readonly chains: readonly ChainRepairReport[];
  readonly totalInvoiceRxFixed: number;
  readonly totalUtxosFixed: number;
}

export async function repairUtxoAddressIndex(
  deps: AppDeps
): Promise<UtxoAddressIndexRepairResult> {
  const seed = deps.secrets.getRequired("MASTER_SEED");
  const utxoAdapters = deps.chains.filter((a) => a.family === "utxo");
  const reports: ChainRepairReport[] = [];

  for (const adapter of utxoAdapters) {
    for (const chainId of adapter.supportedChainIds) {
      const report = await repairChain(deps, adapter, chainId, seed);
      reports.push(report);
    }
  }

  return {
    chains: reports,
    totalInvoiceRxFixed: reports.reduce((s, r) => s + r.invoiceRxFixed, 0),
    totalUtxosFixed: reports.reduce((s, r) => s + r.utxosFixed, 0)
  };
}

async function repairChain(
  deps: AppDeps,
  adapter: AppDeps["chains"][number],
  chainId: ChainId,
  seed: string
): Promise<ChainRepairReport> {
  // Per-chain counter. If absent (no UTXO invoices ever minted on this
  // chain), nothing to repair.
  const [counter] = await deps.db
    .select({ nextIndex: addressIndexCounters.nextIndex })
    .from(addressIndexCounters)
    .where(eq(addressIndexCounters.chainId, chainId))
    .limit(1);
  const counterValue = counter?.nextIndex ?? 0;
  if (counterValue === 0) {
    return {
      chainId,
      counterValue,
      invoiceRxScanned: 0,
      invoiceRxFixed: 0,
      utxosScanned: 0,
      utxosFixed: 0,
      unmatchedAddresses: []
    };
  }

  // Build the address → index map. Addresses are stored lowercase
  // throughout the system; canonicalize to match.
  const indexByAddress = new Map<string, number>();
  for (let i = 0; i < counterValue; i++) {
    const { address } = adapter.deriveAddress(seed, i);
    indexByAddress.set(adapter.canonicalizeAddress(address).toLowerCase(), i);
  }

  // Repair `invoice_receive_addresses` rows on this chain.
  const rxRows = await deps.db
    .select({
      invoiceId: invoiceReceiveAddresses.invoiceId,
      address: invoiceReceiveAddresses.address,
      addressIndex: invoiceReceiveAddresses.addressIndex
    })
    .from(invoiceReceiveAddresses)
    .where(
      and(
        eq(invoiceReceiveAddresses.family, "utxo"),
        eq(invoiceReceiveAddresses.chainId, chainId)
      )
    );

  let invoiceRxFixed = 0;
  const unmatched = new Set<string>();
  for (const row of rxRows) {
    const correct = indexByAddress.get(row.address.toLowerCase());
    if (correct === undefined) {
      unmatched.add(row.address);
      continue;
    }
    if (row.addressIndex !== correct) {
      await deps.db
        .update(invoiceReceiveAddresses)
        .set({ addressIndex: correct })
        .where(
          and(
            eq(invoiceReceiveAddresses.invoiceId, row.invoiceId),
            eq(invoiceReceiveAddresses.family, "utxo"),
            eq(invoiceReceiveAddresses.chainId, chainId)
          )
        );
      invoiceRxFixed += 1;
    }
  }

  // Repair `utxos` rows on this chain.
  const utxoRows = await deps.db
    .select({
      id: utxos.id,
      address: utxos.address,
      addressIndex: utxos.addressIndex
    })
    .from(utxos)
    .where(eq(utxos.chainId, chainId));

  let utxosFixed = 0;
  for (const row of utxoRows) {
    const correct = indexByAddress.get(row.address.toLowerCase());
    if (correct === undefined) {
      unmatched.add(row.address);
      continue;
    }
    if (row.addressIndex !== correct) {
      await deps.db
        .update(utxos)
        .set({ addressIndex: correct })
        .where(eq(utxos.id, row.id));
      utxosFixed += 1;
    }
  }

  return {
    chainId,
    counterValue,
    invoiceRxScanned: rxRows.length,
    invoiceRxFixed,
    utxosScanned: utxoRows.length,
    utxosFixed,
    unmatchedAddresses: [...unmatched]
  };
}
