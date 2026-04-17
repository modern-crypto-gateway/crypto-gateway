import { and, eq, gt, inArray } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainFamily, ChainId } from "../types/chain.js";
import { findChainAdapter } from "./chain-lookup.js";
import { ingestDetectedTransfer } from "./payment.service.js";
import { invoices, invoiceReceiveAddresses } from "../../db/schema.js";

// Cron-triggered orchestrator:
//   1. Enumerate active per-family receive addresses across all non-terminal invoices
//   2. For each chainId with a registered DetectionStrategy.poll, select addresses
//      whose family matches that chain's family and invoke the strategy
//   3. Hand every returned DetectedTransfer to PaymentService.ingestDetectedTransfer
//
// Multi-family compatible: an invoice with acceptedFamilies=["evm","tron"]
// gets its EVM address polled on every EVM chain that has a poll strategy,
// and its Tron address polled on the Tron chain — all in a single tick.

export interface PollPaymentsResult {
  chainsPolled: number;
  addressesWatched: number;
  transfersFound: number;
  transfersIngested: number;
  duplicates: number;
}

export async function pollPayments(deps: AppDeps): Promise<PollPaymentsResult> {
  // Gather every family+address for invoices that are still open. The join
  // table is the authoritative source — `invoices.receive_address` is just
  // the primary-family denormalization for legacy single-chain reads.
  const rows = await deps.db
    .selectDistinct({ family: invoiceReceiveAddresses.family, address: invoiceReceiveAddresses.address })
    .from(invoices)
    .innerJoin(invoiceReceiveAddresses, eq(invoiceReceiveAddresses.invoiceId, invoices.id))
    .where(
      and(
        inArray(invoices.status, ["created", "partial", "detected", "confirmed"]),
        gt(invoices.expiresAt, deps.clock.now().getTime())
      )
    );

  // Group addresses by family once, up front. Each chainId's poll picks
  // the addresses matching its family.
  const addressesByFamily = new Map<ChainFamily, string[]>();
  for (const row of rows) {
    let list = addressesByFamily.get(row.family as ChainFamily);
    if (!list) {
      list = [];
      addressesByFamily.set(row.family as ChainFamily, list);
    }
    list.push(row.address);
  }

  let chainsPolled = 0;
  let transfersFound = 0;
  let transfersIngested = 0;
  let duplicates = 0;
  let addressesWatched = 0;

  // Iterate each chain that has a registered poll strategy. For each,
  // resolve its family via the adapter and pass the family-matching
  // address set. A Tron chainId gets the Tron addresses; an EVM chainId
  // gets the shared EVM address list (valid across every EVM chain).
  for (const [chainIdKey, strategy] of Object.entries(deps.detectionStrategies)) {
    const chainIdNumber = Number(chainIdKey);
    if (!strategy?.poll) continue;
    // adapter tells us which family this chain belongs to
    let family: ChainFamily;
    try {
      family = findChainAdapter(deps, chainIdNumber).family;
    } catch {
      // No adapter wired for this chain — skip. (A rare configuration
      // drift where detectionStrategies references an unwired chainId.)
      continue;
    }
    const addresses = addressesByFamily.get(family) ?? [];
    if (addresses.length === 0) continue;

    chainsPolled += 1;
    addressesWatched += addresses.length;

    const transfers = await strategy.poll(deps, chainIdNumber as ChainId, addresses);
    transfersFound += transfers.length;

    for (const transfer of transfers) {
      const result = await ingestDetectedTransfer(deps, transfer);
      if (result.inserted) {
        transfersIngested += 1;
      } else {
        duplicates += 1;
      }
    }
  }

  return { chainsPolled, addressesWatched, transfersFound, transfersIngested, duplicates };
}
