import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainIdSchema, TxHashSchema } from "./chain.js";
import { MerchantIdSchema } from "./merchant.js";
import { AmountRawSchema } from "./money.js";
import { TokenSymbolSchema } from "./token.js";

// Payout lifecycle:
//   planned   -> row created, source wallet not yet reserved
//   reserved  -> source wallet CAS-reserved so no concurrent payout picks it
//   submitted -> broadcast to the network, awaiting confirmation
//   confirmed -> on-chain confirmed
//   failed    -> broadcast returned an error or on-chain execution reverted
//   canceled  -> canceled before broadcast
export const PayoutStatusSchema = z.enum([
  "planned",
  "reserved",
  "submitted",
  "confirmed",
  "failed",
  "canceled"
]);
export type PayoutStatus = z.infer<typeof PayoutStatusSchema>;

export const PayoutIdSchema = z.string().uuid();
export type PayoutId = Brand<z.infer<typeof PayoutIdSchema>, "PayoutId">;

export const PayoutSchema = z.object({
  id: PayoutIdSchema,
  merchantId: MerchantIdSchema,

  chainId: ChainIdSchema,
  token: TokenSymbolSchema,
  amountRaw: AmountRawSchema,

  // USD-pegged audit. Populated only when the create request used `amountUSD`;
  // both null for `amountRaw` / `amount` paths. `quotedRate` is USD per 1
  // whole token at create time. For non-stable tokens (ETH/MATIC/…) the
  // actual broadcast happens later, so the executed payout's market value
  // drifts from `quotedAmountUsd` — accepted; stables are no-drift.
  quotedAmountUsd: z.string().nullable(),
  quotedRate: z.string().nullable(),

  // Fee tier bound on this payout's broadcast. Defaults to "medium" when
  // unset on create. Only meaningful for chains where the adapter reports
  // `tieringSupported=true` (currently EVM); on Tron / Solana the field is
  // recorded for audit but the broadcast uses the only available fee path.
  feeTier: z.enum(["low", "medium", "high"]).nullable(),
  // Native-units fee at quote time, captured from the chosen tier's
  // `nativeAmountRaw`. Use to compare quoted vs. on-chain actual after
  // confirmation. Null when the create didn't go through the estimate path.
  feeQuotedNative: z.string().nullable(),

  // Optional grouping id for mass-payout batches. Same value across every
  // row of a `POST /payouts/batch` request; null for single creates.
  batchId: z.string().nullable(),

  // True when the create asked the executor to fall back to multi-source
  // if no single wallet had enough balance. When the fallback actually
  // fires, `sourceAddresses` and `txHashes` carry the per-leg detail;
  // otherwise (single-source success or no fallback needed) they stay null.
  allowMultiSource: z.boolean(),
  sourceAddresses: z.array(z.string()).nullable(),
  txHashes: z.array(z.string()).nullable(),

  destinationAddress: AddressSchema,
  // Chosen by source-selection once we know which fee wallet has enough balance + native-gas.
  // null while status="planned".
  sourceAddress: AddressSchema.nullable(),

  txHash: TxHashSchema.nullable(),
  status: PayoutStatusSchema,

  // Gas/energy estimate in native units at the time of build.
  feeEstimateNative: AmountRawSchema.nullable(),
  // Last broadcast error, human-readable.
  lastError: z.string().max(2048).nullable(),

  // Per-payout webhook destination override. Echoed in API responses; the
  // matching secret is write-only (encrypted at rest, never returned). When
  // null, dispatch falls back to the merchant-account webhook.
  webhookUrl: z.string().url().nullable(),

  createdAt: z.date(),
  submittedAt: z.date().nullable(),
  confirmedAt: z.date().nullable(),
  // Set by the broadcast-slot CAS the first time the executor tries to
  // broadcast. Distinguishes "never attempted" (still planned/reserved,
  // not yet picked up) from "attempted at least once" (crashed mid-broadcast
  // → broadcastAttemptedAt set, status possibly still 'reserved').
  // Exposed so operator tooling can spot stuck reservations quickly.
  broadcastAttemptedAt: z.date().nullable(),
  updatedAt: z.date()
});
export type Payout = z.infer<typeof PayoutSchema> & { id: PayoutId };
