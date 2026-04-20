import { z } from "zod";
import type { Address, ChainId } from "./chain.js";
import { ChainIdSchema } from "./chain.js";
import type { AmountRaw } from "./money.js";
import type { TokenSymbol } from "./token.js";

// Opaque payload returned by ChainAdapter.buildTransfer and consumed by
// ChainAdapter.signAndBroadcast. Shape is family-specific: EVM carries
// {to, data, value, gas, nonce, ...}; Tron carries a protobuf message.
// The domain layer never inspects `raw`, only hands it back to the same adapter.
export const UnsignedTxSchema = z.object({
  chainId: ChainIdSchema,
  raw: z.unknown(),
  // Human-readable summary for logging / admin display. Never used for dispatch.
  summary: z.string().max(1024).optional()
});
export type UnsignedTx = z.infer<typeof UnsignedTxSchema>;

export interface BuildTransferArgs {
  chainId: ChainId;
  fromAddress: Address;
  toAddress: Address;
  token: TokenSymbol;
  amountRaw: AmountRaw;
  // Optional explicit gas hints; adapters may ignore.
  gasPriceHint?: AmountRaw;
  nonceHint?: number;
  // Fee tier the caller wants bound on the broadcast tx. EVM binds
  // maxFeePerGas / maxPriorityFeePerGas from the tier's quote; Tron and
  // Solana ignore (no priority concept in the current adapters). Absent =
  // defaults to "medium" where supported.
  feeTier?: "low" | "medium" | "high";
}

export interface EstimateArgs {
  chainId: ChainId;
  fromAddress: Address;
  toAddress: Address;
  token: TokenSymbol;
  amountRaw: AmountRaw;
}
