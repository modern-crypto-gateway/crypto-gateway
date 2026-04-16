import type { ChainAdapter } from "../../../core/ports/chain.port.js";
import type { Logger } from "../../../core/ports/logger.port.js";
import {
  solanaChainAdapter,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID
} from "./solana-chain.adapter.js";

export interface SolanaWiringInput {
  // Preferred: an explicit Solana JSON-RPC URL (Helius, QuickNode, Triton,
  // self-hosted, or `https://solana-mainnet.g.alchemy.com/v2/<key>`). When
  // absent, `alchemyApiKey` triggers an Alchemy URL to be built automatically.
  rpcUrl?: string;
  // Fall-through: auto-construct the Alchemy Solana URL when `rpcUrl` is not
  // set and this key is. Operators wiring Solana via the Alchemy ADDRESS_ACTIVITY
  // webhook usually have this set already for EVM.
  alchemyApiKey?: string;
  network: "mainnet" | "devnet";
  logger: Logger;
}

export interface SolanaWiringResult {
  chainAdapter?: ChainAdapter;
  chainId?: number;
}

// Resolves the Solana RPC URL + constructs the chain adapter. The webhook
// receive path (alchemy-notify.adapter.ts) is stateless and doesn't need RPC,
// but the sweeper calls `getConfirmationStatus` which DOES — so we still
// require a URL when wiring.
//
// SPL payouts (buildTransfer / signAndBroadcast for non-SOL tokens) remain
// DEFERRED: the adapter throws on them today. Receiving SPL USDC/USDT works
// via the webhook path; sending requires the ATA + SPL Token Program
// instruction encoding, which is a separate piece of work.
export function wireSolana(input: SolanaWiringInput): SolanaWiringResult {
  const chainId = input.network === "devnet" ? SOLANA_DEVNET_CHAIN_ID : SOLANA_MAINNET_CHAIN_ID;

  let rpcUrl = input.rpcUrl;
  if (rpcUrl === undefined && input.alchemyApiKey !== undefined && input.alchemyApiKey.length > 0) {
    // Alchemy Solana subdomains: mainnet / devnet. Shasta / testnet not offered.
    const subdomain = input.network === "devnet" ? "solana-devnet" : "solana-mainnet";
    rpcUrl = `https://${subdomain}.g.alchemy.com/v2/${input.alchemyApiKey}`;
  }
  if (rpcUrl === undefined || rpcUrl.length === 0) {
    return {};
  }

  const chainAdapter = solanaChainAdapter({
    chainIds: [chainId],
    rpc: { [chainId]: { url: rpcUrl } }
  });

  input.logger.info("Solana wired", { chainId, rpcProvider: rpcProviderNameFor(rpcUrl) });
  return { chainAdapter, chainId };
}

// Cosmetic: log "alchemy" vs "custom" rather than the full URL (which embeds
// an API key in the Alchemy case).
function rpcProviderNameFor(url: string): string {
  if (url.includes(".alchemy.com/")) return "alchemy";
  if (url.includes("helius")) return "helius";
  if (url.includes("quicknode")) return "quicknode";
  return "custom";
}
