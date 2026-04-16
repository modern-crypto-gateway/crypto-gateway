import type { Address, ChainId } from "./chain.js";
import type { TokenInfo, TokenSymbol } from "./token.js";

// Static token registry. Phase 2 keeps this in core as a minimal hardcoded list;
// Phase 8 can promote it to a DB-backed or config-backed source if merchants
// need to register custom tokens. For now a data-literal keeps the surface small.

export const TOKEN_REGISTRY: readonly TokenInfo[] = [
  // Ethereum mainnet
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 1 as ChainId,
    contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin"
  },
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 1 as ChainId,
    contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether"
  },
  // Polygon PoS
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 137 as ChainId,
    contractAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Polygon)"
  },
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 137 as ChainId,
    contractAddress: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Polygon)"
  },
  // Base
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 8453 as ChainId,
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Base)"
  },
  // Arbitrum One
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 42161 as ChainId,
    contractAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Arbitrum)"
  },
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 42161 as ChainId,
    contractAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Arbitrum)"
  },
  // Sepolia testnet
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 11155111 as ChainId,
    contractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Sepolia)"
  },
  // Tron mainnet (chain id 728126428 = 0x2b6653dc).
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 728126428 as ChainId,
    contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Tron)"
  },
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 728126428 as ChainId,
    contractAddress: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Tron)"
  },
  // Tron Nile testnet (chain id 3448148188 = 0xcd8690dc).
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 3448148188 as ChainId,
    contractAddress: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Tron Nile)"
  },
  // Dev chain token used by the dev chain adapter. chainId 999 / DEV.
  // Kept alongside the real EVM tokens so integration tests have a way to
  // exercise the state machine without hitting a real provider.
  {
    symbol: "DEV" as TokenSymbol,
    chainId: 999 as ChainId,
    contractAddress: null,
    decimals: 6,
    isStable: true,
    displayName: "Dev Token"
  },
  // Solana native asset. chainId 900 = mainnet-beta, 901 = devnet (synthetic ids;
  // Solana has no EVM-style chain id so we assign our own).
  // SPL tokens (USDC/USDT mints) arrive with the Phase 7.5 SPL extension.
  {
    symbol: "SOL" as TokenSymbol,
    chainId: 900 as ChainId,
    contractAddress: null,
    decimals: 9,
    isStable: false,
    displayName: "Solana"
  },
  {
    symbol: "SOL" as TokenSymbol,
    chainId: 901 as ChainId,
    contractAddress: null,
    decimals: 9,
    isStable: false,
    displayName: "Solana (devnet)"
  }
];

export function findToken(chainId: ChainId, symbol: TokenSymbol): TokenInfo | null {
  const match = TOKEN_REGISTRY.find((t) => t.chainId === chainId && t.symbol === symbol);
  return match ?? null;
}
