import { z } from "zod";
import { AddressSchema, ChainIdSchema } from "./chain.js";

// Token symbols are not hard-coded as an enum — the registry is data-driven so
// new stables (USDP, PYUSD, ...) and new networks can be added without core edits.
export const TokenSymbolSchema = z.string().min(1).max(16).regex(/^[A-Z0-9]+$/);
export type TokenSymbol = z.infer<typeof TokenSymbolSchema>;

export const TokenInfoSchema = z.object({
  symbol: TokenSymbolSchema,
  chainId: ChainIdSchema,
  // null for the chain's native asset (ETH on mainnet, TRX on Tron, SOL on Solana).
  contractAddress: AddressSchema.nullable(),
  decimals: z.number().int().min(0).max(36),
  isStable: z.boolean(),
  // Human-readable label, e.g. "USD Coin".
  displayName: z.string().min(1).max(64)
});
export type TokenInfo = z.infer<typeof TokenInfoSchema>;
