import type { AppDeps } from "../app-deps.js";
import type { ChainId } from "../types/chain.js";
import { ingestDetectedTransfer } from "./payment.service.js";

// Cron-triggered orchestrator:
//   1. Enumerate distinct (chain_id, receive_address) pairs for non-terminal orders
//   2. For each chain with a registered DetectionStrategy.poll, invoke it
//   3. Hand every returned DetectedTransfer to PaymentService.ingestDetectedTransfer
//
// Intentionally chain-agnostic — adding a new chain family changes this file
// zero lines; the only change is an entry in `deps.detectionStrategies`.

export interface PollPaymentsResult {
  chainsPolled: number;
  addressesWatched: number;
  transfersFound: number;
  transfersIngested: number;
  duplicates: number;
}

export async function pollPayments(deps: AppDeps): Promise<PollPaymentsResult> {
  // Group active orders by chain so we do one strategy call per chain.
  const rows = await deps.db
    .prepare(
      `SELECT chain_id, receive_address
         FROM orders
        WHERE status IN ('created','pending','partial','detected','confirmed')
          AND expires_at > ?`
    )
    .bind(deps.clock.now().getTime())
    .all<{ chain_id: number; receive_address: string }>();

  const addressesByChain = new Map<number, string[]>();
  for (const row of rows.results) {
    let list = addressesByChain.get(row.chain_id);
    if (!list) {
      list = [];
      addressesByChain.set(row.chain_id, list);
    }
    list.push(row.receive_address);
  }

  let chainsPolled = 0;
  let transfersFound = 0;
  let transfersIngested = 0;
  let duplicates = 0;
  let addressesWatched = 0;

  for (const [chainIdNumber, addresses] of addressesByChain) {
    const chainId = chainIdNumber as ChainId;
    const strategy = deps.detectionStrategies[chainIdNumber];
    if (!strategy?.poll) continue;
    chainsPolled += 1;
    addressesWatched += addresses.length;

    const transfers = await strategy.poll(deps, chainId, addresses);
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
