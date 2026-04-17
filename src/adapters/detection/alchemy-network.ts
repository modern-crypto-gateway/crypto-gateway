import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 as sha256Bytes } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

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

// Chain family per Alchemy-served chainId. Used by bootstrap to pick the
// right address format when seeding a webhook (EVM wants hex, Solana wants
// base58 — passing the wrong format triggers a ValidationError from
// Alchemy's create-webhook endpoint).
export type AlchemyChainFamily = "evm" | "solana";
export const ALCHEMY_FAMILY_BY_CHAIN_ID: Readonly<Record<number, AlchemyChainFamily>> = {
  1: "evm", 10: "evm", 56: "evm", 137: "evm", 8453: "evm", 42161: "evm", 43114: "evm",
  11155111: "evm", 11155420: "evm", 80002: "evm", 84532: "evm", 421614: "evm",
  43113: "evm", 97: "evm",
  900: "solana", 901: "solana"
};

// Placeholder addresses we use to satisfy Alchemy's "≥1 address at webhook
// creation" rule. Bootstrap removes the placeholder from the watch list
// immediately after create so we don't drown in mint/burn events — real
// receive addresses get added via the subscription-sync sweep as invoices
// are placed.
//
// EVM zero address sees ENORMOUS volume on mainnet (every ERC-20 mint/burn
// routes through it — USDC/USDT alone produce thousands of Transfer events
// per day). Watching it would effectively DoS the gateway.
//
// Solana is trickier: Alchemy blocks known PROGRAM addresses in
// create-webhook validation (System Program `11111…11` returns 400 "the
// program address is not supported"), and many well-known vanity addresses
// are either program accounts, mints, or on allowlists we don't control.
// The safest seed is a valid on-curve ed25519 pubkey derived from a
// namespaced string constant — it's indistinguishable from any user
// wallet from Alchemy's perspective, it's deterministic (same value every
// deployment so no surprises), and we remove it immediately post-create so
// whether it ever sees activity is irrelevant.
export const ALCHEMY_PLACEHOLDER_ADDRESS_BY_FAMILY: Readonly<Record<AlchemyChainFamily, string>> = {
  evm: "0x0000000000000000000000000000000000000000",
  solana: computeSolanaPlaceholder()
};

// Invert ALCHEMY_FAMILY_BY_CHAIN_ID + filter by an active-chains allowlist.
// Used by entrypoints to build `deps.alchemySubscribableChainsByFamily` from
// their configured ALCHEMY_CHAINS set. Unknown chainIds (not on Alchemy) are
// dropped rather than throwing — operators who point ALCHEMY_CHAINS at a
// non-Alchemy chain get a no-op for that chain, which is the right behavior.
export function alchemyChainsByFamily(
  activeChainIds: readonly number[]
): Readonly<Record<AlchemyChainFamily, readonly number[]>> {
  const out: Record<AlchemyChainFamily, number[]> = { evm: [], solana: [] };
  for (const chainId of activeChainIds) {
    const family = ALCHEMY_FAMILY_BY_CHAIN_ID[chainId];
    if (family === undefined) continue;
    out[family].push(chainId);
  }
  return out;
}

function computeSolanaPlaceholder(): string {
  // sha256(namespace-string) → ed25519 private key → on-curve pubkey.
  // The resulting address is a stable constant across deployments.
  const seed = sha256Bytes(new TextEncoder().encode("crypto-gateway-bootstrap-placeholder-v1"));
  const pubkey = ed25519.getPublicKey(seed);
  return base58.encode(pubkey);
}
