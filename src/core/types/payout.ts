import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainIdSchema, TxHashSchema } from "./chain.js";
import { MerchantIdSchema } from "./merchant.js";
import { AmountRawSchema } from "./money.js";
import { TokenSymbolSchema } from "./token.js";

// Payout lifecycle:
//   planned    -> row created, source not yet picked
//   reserved   -> source picked, reservation row(s) inserted, awaiting executor
//   topping-up -> sponsor → source gas top-up tx broadcast; waiting for it
//                  to confirm before broadcasting the main payout
//   submitted  -> main tx broadcast to the network, awaiting confirmation
//   confirmed  -> on-chain confirmed
//   failed     -> broadcast returned an error or on-chain execution reverted
//   canceled   -> canceled before broadcast
export const PayoutStatusSchema = z.enum([
  "planned",
  "reserved",
  "topping-up",
  "submitted",
  "confirmed",
  "failed",
  "canceled"
]);
export type PayoutStatus = z.infer<typeof PayoutStatusSchema>;

// `standard` rows are merchant-facing payouts. `gas_top_up` rows are
// internal sibling rows the executor inserts when a source address lacks
// native for gas; they reference the parent via `parentPayoutId` and are
// hidden from the merchant `/payouts` list. `gas_burn` rows are synthetic
// debits created when a standard or gas_top_up payout fails AFTER its tx
// reached chain and consumed gas — recording these keeps `computeSpendable`
// in sync with on-chain reality (EVM/Tron/Solana all charge even for
// reverted txs). gas_burn rows are also filtered out of the merchant list.
export const PayoutKindSchema = z.enum(["standard", "gas_top_up", "gas_burn"]);
export type PayoutKind = z.infer<typeof PayoutKindSchema>;

export const PayoutIdSchema = z.string().uuid();
export type PayoutId = Brand<z.infer<typeof PayoutIdSchema>, "PayoutId">;

export const PayoutSchema = z.object({
  id: PayoutIdSchema,
  merchantId: MerchantIdSchema,

  kind: PayoutKindSchema,
  parentPayoutId: PayoutIdSchema.nullable(),

  chainId: ChainIdSchema,
  token: TokenSymbolSchema,
  amountRaw: AmountRawSchema,

  // USD-pegged audit. Populated only when the create request used `amountUSD`;
  // both null for `amountRaw` / `amount` paths.
  quotedAmountUsd: z.string().nullable(),
  quotedRate: z.string().nullable(),

  // Fee tier bound on this payout's broadcast. Defaults to "medium" when
  // unset on create.
  feeTier: z.enum(["low", "medium", "high"]).nullable(),
  feeQuotedNative: z.string().nullable(),

  // Optional grouping id for mass-payout batches.
  batchId: z.string().nullable(),

  destinationAddress: AddressSchema,
  // Chosen by `selectSource` once we know which HD address has enough
  // balance. Null while status="planned".
  sourceAddress: AddressSchema.nullable(),

  txHash: TxHashSchema.nullable(),

  // Set on the standard row when a gas-top-up sibling was needed. The
  // sibling's own `id` lives in `parentPayoutId` lookups; these fields
  // duplicate the broadcast detail for direct visibility on the parent.
  topUpTxHash: TxHashSchema.nullable(),
  topUpSponsorAddress: AddressSchema.nullable(),
  // Native amount the sponsor sends to the source (gap + cushion). Set at
  // plan time; the executor reads it to build the top-up tx without having
  // to reverse-derive from the sponsor reservation (which carries
  // amount+gas, not the transfer amount alone).
  topUpAmountRaw: AmountRawSchema.nullable(),

  status: PayoutStatusSchema,

  // Gas/energy estimate in native units at the time of build.
  feeEstimateNative: AmountRawSchema.nullable(),
  lastError: z.string().max(2048).nullable(),

  webhookUrl: z.string().url().nullable(),

  // Confirmation count required for this payout's tx to flip from
  // `submitted` to `confirmed`. Snapshotted at plan time using the
  // merchant's per-chain override (or env / gateway default). Frozen for
  // the row's lifetime — merchant policy edits don't reshape in-flight
  // payouts. Nullable for back-compat with pre-migration rows.
  confirmationThreshold: z.number().int().positive().nullable(),

  // Snapshot of merchant.confirmation_tiers_json at plan time, parsed back
  // into its object form for API responses. The payout-confirmation sweep
  // evaluates the rule list for `${chainId}:${token}` against the payout's
  // amount; on no match, falls back to the flat `confirmationThreshold`.
  // NULL = no tiers.
  confirmationTiers: z
    .record(
      z.string(),
      z.array(
        z.object({
          amount: z.string().optional(),
          op: z.enum(["<", "<=", ">", ">=", "=", "<>"]).optional(),
          confirmations: z.number().int().positive()
        })
      )
    )
    .nullable(),

  createdAt: z.date(),
  submittedAt: z.date().nullable(),
  confirmedAt: z.date().nullable(),
  broadcastAttemptedAt: z.date().nullable(),
  updatedAt: z.date()
});
export type Payout = z.infer<typeof PayoutSchema> & { id: PayoutId };
