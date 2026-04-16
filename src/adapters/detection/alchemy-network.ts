// chainId <-> Alchemy Notify network name. Two consumers:
//   - alchemy-notify.adapter.ts   — map inbound network name -> chainId when parsing webhook payloads
//   - alchemy-admin-client.ts     — map our chainId -> network name when creating webhooks
//
// Keeping the source of truth in one file prevents the maps from drifting.
// Reference: https://docs.alchemy.com/reference/notify-api-quickstart#supported-networks

export const ALCHEMY_NETWORK_BY_CHAIN_ID: Readonly<Record<number, string>> = {
  1: "ETH_MAINNET",
  11155111: "ETH_SEPOLIA",
  10: "OPT_MAINNET",
  11155420: "OPT_SEPOLIA",
  42161: "ARB_MAINNET",
  421614: "ARB_SEPOLIA",
  8453: "BASE_MAINNET",
  84532: "BASE_SEPOLIA",
  137: "MATIC_MAINNET",
  80002: "MATIC_AMOY",
  // BNB Smart Chain + Avalanche C-Chain. The enum strings below follow
  // Alchemy's observed naming convention (`<shortname>_MAINNET`) and the
  // confirmed RPC subdomains `bnb-mainnet` / `avax-mainnet`. If Alchemy's
  // webhook API rejects these with an "invalid network" error, adjust the
  // string here — the RPC-level calls don't need the map at all (they use
  // the subdomain directly via alchemy-rpc.ts), so switching detection
  // strategies to poll is a workaround until the mapping is corrected.
  56: "BNB_MAINNET",
  97: "BNB_TESTNET",
  43114: "AVAX_MAINNET",
  43113: "AVAX_FUJI",
  // Solana. ChainIds 900/901 are our own synthetic values (Solana has no
  // EVM-style chain id). Alchemy exposes Solana ADDRESS_ACTIVITY webhooks
  // whose payload shape differs from EVM — the alchemy-notify adapter
  // branches on network to pick the right parser.
  900: "SOLANA_MAINNET",
  901: "SOLANA_DEVNET"
};

export const CHAIN_ID_BY_ALCHEMY_NETWORK: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.entries(ALCHEMY_NETWORK_BY_CHAIN_ID).map(([id, name]) => [name, Number(id)]))
);
