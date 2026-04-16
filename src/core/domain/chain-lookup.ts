import type { AppDeps } from "../app-deps.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import type { ChainId } from "../types/chain.js";

// Resolves chainId -> ChainAdapter by asking each adapter which chainIds it serves.
// The domain uses this instead of branching on family — adding a new chain
// family (Solana, Bitcoin) never requires editing this file.

export function findChainAdapter(deps: AppDeps, chainId: ChainId): ChainAdapter {
  const adapter = deps.chains.find((a) => a.supportedChainIds.includes(chainId));
  if (!adapter) {
    throw new Error(`No chain adapter registered for chainId ${chainId}`);
  }
  return adapter;
}
