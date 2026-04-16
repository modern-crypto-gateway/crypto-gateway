// chainId -> Alchemy subdomain name. Reference:
// https://docs.alchemy.com/reference/available-networks
//
// Only chains Alchemy actually serves are listed; anything else passed in
// `alchemyRpcUrls` is silently skipped so the caller can safely enumerate a
// broader set (e.g. "every chain the operator configured").

const ALCHEMY_SUBDOMAIN_BY_CHAIN_ID: Readonly<Record<number, string>> = {
  // Mainnets
  1: "eth-mainnet",
  10: "opt-mainnet",
  137: "polygon-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
  43114: "avax-mainnet",
  56: "bnb-mainnet",
  // Testnets — opt-in (not in the default mainnet set below)
  11155111: "eth-sepolia",
  11155420: "opt-sepolia",
  80002: "polygon-amoy",
  84532: "base-sepolia",
  421614: "arb-sepolia",
  43113: "avax-fuji",
  97: "bnb-testnet"
};

// Default set enabled when `ALCHEMY_API_KEY` is set and the operator hasn't
// narrowed it via `ALCHEMY_CHAINS`. Mainnets only — testnets should be opt-in
// so we don't surprise someone into signing keys against a real chain.
export const DEFAULT_ALCHEMY_MAINNET_CHAIN_IDS: readonly number[] = [
  1, 10, 137, 8453, 42161, 43114, 56
];

// Build a chainId -> RPC URL map for the given chain ids using the supplied
// API key. Chains Alchemy doesn't serve are skipped; the caller is expected
// to fall back (to public RPC, self-hosted, etc.) for those.
export function alchemyRpcUrls(apiKey: string, chainIds: readonly number[]): Record<number, string> {
  const urls: Record<number, string> = {};
  for (const chainId of chainIds) {
    const subdomain = ALCHEMY_SUBDOMAIN_BY_CHAIN_ID[chainId];
    if (subdomain === undefined) continue;
    urls[chainId] = `https://${subdomain}.g.alchemy.com/v2/${apiKey}`;
  }
  return urls;
}

// All chain ids Alchemy supports. Useful for documentation / health checks /
// "did the operator configure a chain Alchemy doesn't serve" warnings.
export function alchemySupportedChainIds(): readonly number[] {
  return Object.keys(ALCHEMY_SUBDOMAIN_BY_CHAIN_ID).map((s) => Number(s));
}

// Parse a comma-separated chain-id list into numbers, dropping blanks and
// non-finite entries. Used to interpret `ALCHEMY_CHAINS` env var.
export function parseAlchemyChainsEnv(raw: string | undefined): readonly number[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ALCHEMY_MAINNET_CHAIN_IDS;
  const out: number[] = [];
  for (const token of raw.split(",")) {
    const n = Number.parseInt(token.trim(), 10);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out.length > 0 ? out : DEFAULT_ALCHEMY_MAINNET_CHAIN_IDS;
}
