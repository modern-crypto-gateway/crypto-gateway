import type { AppDeps } from "../app-deps.js";
import type { Address, ChainId } from "../types/chain.js";
import type { DetectedTransfer } from "../types/transaction.js";

// DetectionStrategy decouples "how do new transfers reach us" from ChainAdapter.
// The same EVM ChainAdapter pairs with either:
//   - alchemy-notify.adapter (push: subscribe at boot, handlePush on webhook)
//   - evm-rpc-poll.adapter   (pull: periodic scanIncoming via the chain adapter)
//
// Implementations populate the methods relevant to their mode. The domain
// never branches on which strategy is wired — it simply calls the ones that exist.

export interface DetectionStrategy {
  // Optional: run once at app boot. Push-based adapters use this to register
  // webhooks with their provider. Called from entrypoints during startup.
  start?(deps: AppDeps, chainId: ChainId): Promise<void>;

  // Optional: pull path. Cron/scheduled handlers call this to scan for new transfers.
  poll?(
    deps: AppDeps,
    chainId: ChainId,
    addresses: readonly Address[]
  ): Promise<readonly DetectedTransfer[]>;

  // Optional: push path. The HTTP webhook-ingest route calls this to translate
  // a raw provider payload into DetectedTransfers the domain can persist.
  handlePush?(deps: AppDeps, rawPayload: unknown): Promise<readonly DetectedTransfer[]>;
}
