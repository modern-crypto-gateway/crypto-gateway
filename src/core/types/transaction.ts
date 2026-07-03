import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainIdSchema, TxHashSchema } from "./chain.js";
import { AmountRawSchema } from "./money.js";
import { InvoiceIdSchema } from "./invoice.js";
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
  // null until we match the tx to an invoice (e.g. orphan incoming transfers to
  // an unknown receive address pending manual reconciliation).
  invoiceId: InvoiceIdSchema.nullable(),

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
  confirmedAt: z.date().nullable(),
  // True on-chain block time (separate from detectedAt/confirmedAt wall-clock).
  // NULL when the detection source can't supply it. Drives time-correct
  // attribution on the re-ingest path; never used by reorg/sweep logic.
  onchainTime: z.date().nullable(),

  // USD valuation captured when the payment was first priced (oracle quote at
  // detection time). Both null on legacy single-token invoices and on rows
  // the oracle couldn't price. Stored — not derived on read — so the GET
  // breakdown reflects the same rate the invoice was credited at, even if
  // the live oracle has since moved.
  amountUsd: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  usdRate: z.string().regex(/^\d+(\.\d+)?$/).nullable()
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
  // Wall-clock observation time (when detection saw the transfer).
  seenAt: z.date(),
  // True on-chain block time of the transfer. Distinct from `seenAt`. Adapters
  // that can source it (poll paths reading block/slot timestamps) populate it;
  // webhook/push paths and mempool/0-conf transfers leave it null. Defaulted to
  // null so any path or test that omits it stays valid. Consumed by the
  // re-ingest matcher (ingestDetectedTransfer source='reingest') to attribute
  // the transfer to the invoice that owned the address at this time.
  onchainTime: z.date().nullable().default(null)
});
export type DetectedTransfer = z.infer<typeof DetectedTransferSchema>;
