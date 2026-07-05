import type { AppDeps } from "../../core/app-deps.js";
import type { Address, ChainId } from "../../core/types/chain.js";
import type { TokenSymbol } from "../../core/types/token.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import type { DetectionStrategy } from "../../core/ports/detection.port.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import { isMoneroChainAdapter } from "../chains/monero/monero-chain.adapter.js";

// Reduce a committed cursor so it never sits at or above the block of any
// transfer whose ingest failed — the next resume then re-scans that block
// (dedup absorbs the siblings that already ingested). Mirrors the txpool
// watcher's blockPass holdback exactly. Block-scan transfers always carry a
// concrete blockNumber (scanBlockRange stamps the walked height), so the
// null guard is belt-and-suspenders.
function clampCursorBelowFailures(
  scannedTo: number | null,
  failed: readonly DetectedTransfer[] | undefined
): number | null {
  if (scannedTo === null || failed === undefined || failed.length === 0) return scannedTo;
  let advanceTo = scannedTo;
  for (const t of failed) {
    if (t.blockNumber !== null) advanceTo = Math.min(advanceTo, t.blockNumber - 1);
  }
  return advanceTo;
}

// Cron-driven Monero block-scan detection strategy — the FALLBACK path,
// registered only when the txpool watcher isn't running (no MONERO_WATCHER_DO
// binding on Workers, or MONERO_TXPOOL=off). Deployments with the watcher
// skip this strategy entirely: the watcher owns both the pool pass and the
// block walk, and a second scanner here would just double-poll the RPC fleet.
//
// Why not the generic rpcPollDetection: that strategy funnels through
// adapter.scanIncoming, which must persist its own block cursor BEFORE
// pollPayments ingests the returned transfers — a crash between the two
// loses every payment in the walked range permanently (the cursor never
// looks at those blocks again). This strategy uses the adapter's
// scanIncomingDetailed/commitScanCheckpoint split with pollPayments'
// commit() hook: the cursor is written only AFTER the ingest loop finished,
// so a mid-ingest crash re-scans (dedup absorbs) instead of losing funds.
export function moneroBlockScanDetection(): DetectionStrategy {
  // scannedTo from the last poll(), awaiting commit. Keyed by chainId —
  // one strategy instance can serve mainnet + stagenet simultaneously.
  const pendingByChain = new Map<number, number | null>();

  return {
    async poll(
      deps: AppDeps,
      chainId: ChainId,
      addresses: readonly Address[],
      tokens?: readonly TokenSymbol[]
    ): Promise<readonly DetectedTransfer[]> {
      const adapter = findChainAdapter(deps, chainId);
      if (!isMoneroChainAdapter(adapter)) return [];
      const { transfers, scannedTo } = await adapter.scanIncomingDetailed({
        chainId,
        addresses,
        // No caller-side token filter means "scan everything this chain
        // has" — for Monero that's XMR, always.
        tokens: tokens ?? (["XMR"] as TokenSymbol[])
      });
      pendingByChain.set(chainId, scannedTo);
      return transfers;
    },

    async commit(
      deps: AppDeps,
      chainId: ChainId,
      failedTransfers?: readonly DetectedTransfer[]
    ): Promise<void> {
      const pending = pendingByChain.get(chainId);
      if (pending === undefined) return;
      pendingByChain.delete(chainId);
      const adapter = findChainAdapter(deps, chainId);
      if (!isMoneroChainAdapter(adapter)) return;
      // Never advance the cursor past a block whose transfer failed to
      // ingest — that payment would be skipped forever on the next resume
      // (there's no snap-back; the scan strictly resumes from cursor+1).
      const advanceTo = clampCursorBelowFailures(pending, failedTransfers);
      await adapter.commitScanCheckpoint(advanceTo);
    }
  };
}
