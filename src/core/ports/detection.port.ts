import type { AppDeps } from "../app-deps.js";
import type { Address, ChainId } from "../types/chain.js";
import type { TokenSymbol } from "../types/token.js";
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
  // `tokens` is the set of token symbols any active invoice on this chain
  // accepts (legacy invoices contribute their single `token`, USD-pegged
  // invoices contribute every key in `ratesJson`). The strategy uses it to
  // skip RPC calls for tokens nobody is currently watching — so a chain that
  // registers USDT, USDC, DAI, BUSD but only has an active USDC invoice
  // produces 1 getLogs call per tick instead of 4. An empty set means
  // "no active invoices want any token on this chain"; the strategy returns
  // immediately. Undefined means "no caller-side filter", and the strategy
  // falls back to scanning every token in the registry for this chain (used
  // when callers don't or can't compute the set).
  poll?(
    deps: AppDeps,
    chainId: ChainId,
    addresses: readonly Address[],
    tokens?: readonly TokenSymbol[]
  ): Promise<readonly DetectedTransfer[]>;

  // Optional: push path. The HTTP webhook-ingest route calls this to translate
  // a raw provider payload into DetectedTransfers the domain can persist.
  handlePush?(deps: AppDeps, rawPayload: unknown): Promise<readonly DetectedTransfer[]>;
}
