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
  80002: "MATIC_AMOY"
};

export const CHAIN_ID_BY_ALCHEMY_NETWORK: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.entries(ALCHEMY_NETWORK_BY_CHAIN_ID).map(([id, name]) => [name, Number(id)]))
);
