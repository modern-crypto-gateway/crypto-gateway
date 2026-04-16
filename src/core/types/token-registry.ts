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
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 8453 as ChainId,
    contractAddress: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Base)"
  },
  // OP Mainnet (Optimism). chainId 10.
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 10 as ChainId,
    contractAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Optimism)"
  },
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 10 as ChainId,
    contractAddress: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Optimism)"
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
  // Avalanche C-Chain. chainId 43114. Native USDC/USDT mints (6 decimals,
  // same as most EVMs — NOT the 18-decimal BSC-style bridged tokens).
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 43114 as ChainId,
    contractAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Avalanche)"
  },
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 43114 as ChainId,
    contractAddress: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Avalanche)"
  },
  // BNB Smart Chain. chainId 56. These are the Binance-Peg BEP-20 tokens
  // bridged from Ethereum — 18 decimals, NOT 6 like most USDC/USDT. If you
  // display amounts, quote them against the token's declared decimals, never
  // assume 6.
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 56 as ChainId,
    contractAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address,
    decimals: 18,
    isStable: true,
    displayName: "USD Coin (BSC)"
  },
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 56 as ChainId,
    contractAddress: "0x55d398326f99059fF775485246999027B3197955" as Address,
    decimals: 18,
    isStable: true,
    displayName: "Tether (BSC)"
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
  },
  // SPL tokens on Solana mainnet. The `contractAddress` field holds the SPL
  // token MINT address (a pubkey, not an EVM-style contract). Detection
  // matches by owner+mint in the Alchemy Notify webhook branch. Payouts
  // (signAndBroadcast for SPL) are still deferred — native SOL works.
  {
    symbol: "USDC" as TokenSymbol,
    chainId: 900 as ChainId,
    contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address,
    decimals: 6,
    isStable: true,
    displayName: "USD Coin (Solana)"
  },
  {
    symbol: "USDT" as TokenSymbol,
    chainId: 900 as ChainId,
    contractAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address,
    decimals: 6,
    isStable: true,
    displayName: "Tether (Solana)"
  }
];

export function findToken(chainId: ChainId, symbol: TokenSymbol): TokenInfo | null {
  const match = TOKEN_REGISTRY.find((t) => t.chainId === chainId && t.symbol === symbol);
  return match ?? null;
}
