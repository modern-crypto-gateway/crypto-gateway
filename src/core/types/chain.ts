import { z } from "zod";

export const ChainFamilySchema = z.enum(["evm", "tron", "solana"]);
export type ChainFamily = z.infer<typeof ChainFamilySchema>;

export const ChainIdSchema = z.number().int().positive();
export type ChainId = z.infer<typeof ChainIdSchema>;

// Address is a plain string at the schema level — each ChainAdapter is
// responsible for `validateAddress` and `canonicalizeAddress` on its family.
// Tron addresses are base58 and case-sensitive; EVM are 0x-hex and
// case-insensitive (canonical form = EIP-55 checksummed).
export const AddressSchema = z.string().min(1).max(128);
export type Address = z.infer<typeof AddressSchema>;

export const TxHashSchema = z.string().min(1).max(128);
export type TxHash = z.infer<typeof TxHashSchema>;
