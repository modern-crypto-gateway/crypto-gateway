import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainIdSchema, TxHashSchema } from "./chain.js";
import { AmountRawSchema } from "./money.js";
import { OrderIdSchema } from "./order.js";
import { TokenSymbolSchema } from "./token.js";

// Per-transaction lifecycle:
//   detected  -> seen in mempool or a recent block
//   confirmed -> crossed the configured confirmation threshold
//   reverted  -> included in a block but execution failed
//   orphaned  -> chain reorganized it out; no longer in the canonical chain
export const TxStatusSchema = z.enum(["detected", "confirmed", "reverted", "orphaned"]);
export type TxStatus = z.infer<typeof TxStatusSchema>;

export const TransactionIdSchema = z.string().uuid();
export type TransactionId = Brand<z.infer<typeof TransactionIdSchema>, "TransactionId">;

export const TransactionSchema = z.object({
  id: TransactionIdSchema,
  // null until we match the tx to an order (e.g. orphan incoming transfers to an
  // unknown receive address pending manual reconciliation).
  orderId: OrderIdSchema.nullable(),

  chainId: ChainIdSchema,
  txHash: TxHashSchema,
  // Some chains emit multiple transfers per tx; the (txHash, logIndex) pair is the true unique key.
  logIndex: z.number().int().nonnegative().nullable(),

  fromAddress: AddressSchema,
  toAddress: AddressSchema,
  token: TokenSymbolSchema,
  amountRaw: AmountRawSchema,

  blockNumber: z.number().int().nonnegative().nullable(),
  confirmations: z.number().int().nonnegative(),
  status: TxStatusSchema,

  detectedAt: z.date(),
  confirmedAt: z.date().nullable()
});
export type Transaction = z.infer<typeof TransactionSchema> & { id: TransactionId };

// DetectedTransfer is what a ChainAdapter returns from `scanIncoming` or a
// DetectionStrategy returns from `handlePush`. It is the pre-normalized,
// pre-persisted shape; the domain promotes it to a Transaction row.
export const DetectedTransferSchema = z.object({
  chainId: ChainIdSchema,
  txHash: TxHashSchema,
  logIndex: z.number().int().nonnegative().nullable(),
  fromAddress: AddressSchema,
  toAddress: AddressSchema,
  token: TokenSymbolSchema,
  amountRaw: AmountRawSchema,
  blockNumber: z.number().int().nonnegative().nullable(),
  // Adapters report as many confirmations as they can see; 0 is valid.
  confirmations: z.number().int().nonnegative(),
  seenAt: z.date()
});
export type DetectedTransfer = z.infer<typeof DetectedTransferSchema>;
