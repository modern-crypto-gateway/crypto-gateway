import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bitcoinChainAdapter } from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { repairUtxoAddressIndex } from "../../core/domain/utxo-address-index-repair.js";
import {
  invoiceReceiveAddresses,
  transactions,
  utxos
} from "../../db/schema.js";
import type { ChainId } from "../../core/types/chain.js";
import { bootTestApp, createInvoiceViaApi } from "../helpers/boot.js";

// Repairs the address_index bug from migration 0006: in pre-fix multi-
// family invoices, detection ingest stamped `utxos.address_index` with the
// primary family's index from `invoices.address_index` instead of the
// per-chain UTXO counter index. Migration 0006 backfilled the new
// `invoice_receive_addresses.address_index` column from the same wrong
// source. This script re-derives every counter slot from MASTER_SEED and
// corrects rows whose `address` ↔ `address_index` no longer match.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const BTC_CHAIN_ID = 800 as ChainId;
const WRONG_INDEX = 9999;

describe("repairUtxoAddressIndex", () => {
  it("corrects invoice_receive_addresses + utxos rows whose address_index drifted from the address", async () => {
    const booted = await bootTestApp({
      chains: [bitcoinChainAdapter()],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      // Mint two BTC invoices so the counter advances to 2.
      const inv0 = await createInvoiceViaApi(booted, {
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "1000"
      });
      const inv1 = await createInvoiceViaApi(booted, {
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "2000"
      });
      expect(inv0.addressIndex).toBe(0);
      expect(inv1.addressIndex).toBe(1);

      // Insert a utxo row paying invoice 1's address but with a CORRUPTED
      // address_index (simulates the pre-fix multi-family bug). The
      // address itself decodes correctly to the chain's slot-1 derivation;
      // only the index column is wrong.
      const now = booted.deps.clock.now().getTime();
      const txId = "tx-corrupt";
      await booted.deps.db.insert(transactions).values({
        id: txId,
        invoiceId: inv1.id,
        chainId: BTC_CHAIN_ID,
        txHash: "ab".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qsenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        toAddress: inv1.receiveAddress,
        token: "BTC",
        amountRaw: "2000",
        blockNumber: 100,
        confirmations: 12,
        status: "confirmed",
        detectedAt: now
      });
      await booted.deps.db.insert(utxos).values({
        id: `${"ab".repeat(32)}:0`,
        transactionId: txId,
        chainId: BTC_CHAIN_ID,
        address: inv1.receiveAddress,
        addressIndex: WRONG_INDEX,
        vout: 0,
        valueSats: "2000",
        scriptPubkey: "0014" + "ff".repeat(20),
        spentInPayoutId: null,
        spentAt: null,
        createdAt: now
      });

      // Also corrupt the receive-address row for invoice 1 (mirrors what
      // migration 0006's wrong-source backfill produced for multi-family
      // pre-fix rows).
      await booted.deps.db
        .update(invoiceReceiveAddresses)
        .set({ addressIndex: WRONG_INDEX })
        .where(eq(invoiceReceiveAddresses.invoiceId, inv1.id));

      // Run repair.
      const report = await repairUtxoAddressIndex(booted.deps);

      // Expect the BTC chain entry to show fixes for both tables.
      const btc = report.chains.find((c) => c.chainId === BTC_CHAIN_ID);
      expect(btc).toBeDefined();
      expect(btc!.counterValue).toBe(2);
      expect(btc!.invoiceRxFixed).toBe(1);
      expect(btc!.utxosFixed).toBe(1);
      expect(btc!.unmatchedAddresses).toEqual([]);
      expect(report.totalInvoiceRxFixed).toBe(1);
      expect(report.totalUtxosFixed).toBe(1);

      // Verify the fixes landed.
      const [fixedRx] = await booted.deps.db
        .select({ addressIndex: invoiceReceiveAddresses.addressIndex })
        .from(invoiceReceiveAddresses)
        .where(eq(invoiceReceiveAddresses.invoiceId, inv1.id));
      expect(fixedRx!.addressIndex).toBe(1);

      const [fixedUtxo] = await booted.deps.db
        .select({ addressIndex: utxos.addressIndex })
        .from(utxos)
        .where(eq(utxos.id, `${"ab".repeat(32)}:0`));
      expect(fixedUtxo!.addressIndex).toBe(1);

      // Idempotent: re-running with a clean DB fixes nothing.
      const second = await repairUtxoAddressIndex(booted.deps);
      expect(second.totalInvoiceRxFixed).toBe(0);
      expect(second.totalUtxosFixed).toBe(0);
    } finally {
      await booted.close();
    }
  });

  it("reports unmatched addresses without crashing when a row's address can't be derived from the current seed", async () => {
    // Edge case: an address in the DB that doesn't match any seed slot.
    // Shouldn't happen with the same MASTER_SEED, but if it does, the
    // operator gets a clear unmatched list rather than silent skipping.
    const booted = await bootTestApp({
      chains: [bitcoinChainAdapter()],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const inv = await createInvoiceViaApi(booted, {
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "1000"
      });
      const now = booted.deps.clock.now().getTime();
      // Use a foreign address that can't be derived from MASTER_SEED.
      const foreignAddress = "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy9k";
      await booted.deps.db.insert(transactions).values({
        id: "tx-foreign",
        invoiceId: inv.id,
        chainId: BTC_CHAIN_ID,
        txHash: "cd".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qsenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        toAddress: foreignAddress,
        token: "BTC",
        amountRaw: "1000",
        blockNumber: 100,
        confirmations: 12,
        status: "confirmed",
        detectedAt: now
      });
      await booted.deps.db.insert(utxos).values({
        id: `${"cd".repeat(32)}:0`,
        transactionId: "tx-foreign",
        chainId: BTC_CHAIN_ID,
        address: foreignAddress,
        addressIndex: 5,
        vout: 0,
        valueSats: "1000",
        scriptPubkey: "0014" + "ee".repeat(20),
        spentInPayoutId: null,
        spentAt: null,
        createdAt: now
      });

      const report = await repairUtxoAddressIndex(booted.deps);
      const btc = report.chains.find((c) => c.chainId === BTC_CHAIN_ID);
      expect(btc!.unmatchedAddresses).toContain(foreignAddress);
      // Foreign rows are skipped, not silently corrupted.
      expect(btc!.utxosFixed).toBe(0);
    } finally {
      await booted.close();
    }
  });
});
