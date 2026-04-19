import type { AppDeps } from "../../core/app-deps.js";
import type { DetectionStrategy } from "../../core/ports/detection.port.ts";
import type { Address, ChainId } from "../../core/types/chain.js";
import type { TokenSymbol } from "../../core/types/token.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import { findChainAdapter } from "../../core/domain/chain-lookup.js";
import { TOKEN_REGISTRY } from "../../core/types/token-registry.js";

export interface RpcPollConfig {
  // Fallback scan window when no "last poll" checkpoint exists in cache.
  // Defaults to 5 minutes.
  defaultLookbackMs?: number;
  // Cache key prefix for per-chain "last poll since" checkpoints.
  // Defaults to "poll:last_since_ms:".
  cachePrefix?: string;
  // Minimum wall-clock gap between consecutive `poll` calls for this chain.
  // Returns an empty transfer list without touching the RPC if the last
  // successful poll was more recent. Undefined = run on every cron tick.
  //
  // Useful for rate-limited providers: TronGrid's free tier is 100k req/day,
  // so setting minIntervalMs=300_000 (5 min) cuts detection traffic to ~20%
  // of a 1-minute cron at the cost of proportionally more detection latency.
  // Per-chain checkpoints persist in the same cache entry used for the
  // scan window, so throttle + lookback stay consistent across restarts.
  minIntervalMs?: number;
  // Indexing-lag safety buffer: after a successful scan at wall-clock `T`,
  // the checkpoint is written as `T - checkpointGraceMs` instead of `T`, so
  // a tx whose block landed just before `T` but whose provider-side index
  // hasn't caught up yet is still inside the next tick's scan window.
  // Without this, TronGrid's few-second block_timestamp indexing lag causes
  // permanent misses: the tx lands at T-2s, we poll at T and TronGrid doesn't
  // yet return it, we advance the checkpoint to T, next tick we query from T
  // (past the tx's block_timestamp) and the tx is invisible forever.
  // Idempotency of ingest (UNIQUE chain_id,tx_hash,log_index) absorbs the
  // resulting small scan-window overlap. Defaults to 2 minutes.
  checkpointGraceMs?: number;
}

// Generic pull-based detection: delegates to the chain adapter's scanIncoming,
// which each family implements against its own RPC surface (viem for EVM,
// TronGrid for Tron). Works for any family; the strategy is intentionally
// thin — all RPC-shape knowledge lives in the chain adapter.
//
// Maintains a per-chain "last poll since" checkpoint in the cache so each
// call scans only new blocks. On a cold cache it defaults to `defaultLookbackMs`.

export function rpcPollDetection(config: RpcPollConfig = {}): DetectionStrategy {
  const defaultLookbackMs = config.defaultLookbackMs ?? 5 * 60 * 1000;
  const prefix = config.cachePrefix ?? "poll:last_since_ms:";
  const minIntervalMs = config.minIntervalMs;
  const checkpointGraceMs = config.checkpointGraceMs ?? 2 * 60 * 1000;

  return {
    async poll(
      deps: AppDeps,
      chainId: ChainId,
      addresses: readonly Address[],
      tokens?: readonly TokenSymbol[]
    ): Promise<readonly DetectedTransfer[]> {
      if (addresses.length === 0) return [];
      // Caller passed an explicit empty filter — no active invoice on this
      // chain wants any token. Bail before touching the provider; this is the
      // hot path that previously scanned the full registry every tick.
      if (tokens !== undefined && tokens.length === 0) return [];
      const chainAdapter = findChainAdapter(deps, chainId);

      const cacheKey = `${prefix}${chainId}`;
      const lastSinceRaw = await deps.cache.get(cacheKey);
      const now = deps.clock.now().getTime();
      const lastCheckpoint = lastSinceRaw !== null ? Number(lastSinceRaw) : null;

      // Throttle: if the last successful poll was more recent than
      // `minIntervalMs`, return without touching the provider. The scan
      // window stays open (we don't advance the checkpoint) so when the
      // next call does run it catches everything since the last actual
      // scan — no missed blocks, just delayed detection. Throttle compares
      // against the unmodified last-poll checkpoint, NOT the grace-extended
      // scan floor — otherwise grace would silently halve the min interval.
      if (minIntervalMs !== undefined && lastCheckpoint !== null && now - lastCheckpoint < minIntervalMs) {
        return [];
      }

      // Scan-window lower bound. We extend backwards by `checkpointGraceMs`
      // to absorb provider indexing lag: a tx whose block landed just
      // before our last poll but wasn't yet returned by the provider's
      // index at that time would otherwise never be seen again. Idempotent
      // ingest (UNIQUE chain_id,tx_hash,log_index) dedups the resulting
      // tiny overlap at zero cost.
      const sinceMs =
        lastCheckpoint !== null
          ? lastCheckpoint - checkpointGraceMs
          : now - defaultLookbackMs;

      // Resolve token list. Caller-supplied wins (filtered to tokens registered
      // on this chain so an unknown symbol doesn't blow up scanIncoming);
      // when caller passes nothing, fall back to scanning every token in the
      // registry for this chain (legacy behaviour, used by tests + callers
      // that can't compute the active-invoice set).
      const registryForChain = TOKEN_REGISTRY.filter((t) => t.chainId === chainId).map((t) => t.symbol);
      const scanTokens =
        tokens === undefined
          ? registryForChain
          : registryForChain.filter((sym) => tokens.includes(sym));
      if (scanTokens.length === 0) return [];

      const transfers = await chainAdapter.scanIncoming({ chainId, addresses, tokens: scanTokens, sinceMs });

      // Advance the checkpoint to `now` regardless of how many transfers
      // the scan returned. A transient provider outage just surfaces as 0
      // hits; re-scanning the same window repeatedly is wasteful. The
      // grace window that protects against provider indexing lag is
      // applied when deriving `sinceMs` above, NOT here — so the throttle
      // check stays honest.
      await deps.cache.put(cacheKey, now.toString(), { ttlSeconds: 7 * 24 * 3600 });

      return transfers;
    }
  };
}
