import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainFamilySchema, ChainIdSchema } from "./chain.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema } from "./money.js";
import { MerchantIdSchema } from "./merchant.js";
import { TokenSymbolSchema } from "./token.js";

// Invoice lifecycle. Two orthogonal axes:
//
// `status` — where the invoice sits in its journey:
//   pending    -> awaiting first detection (or re-opened after all contributing
//                 txs reverted)
//   processing -> at least one tx seen (confirmed or not), threshold not yet met
//   completed  -> confirmed payment ≥ threshold (within tolerance)
//   expired    -> expiry window elapsed without enough confirmed funds
//   canceled   -> merchant canceled before completion
//
// `extraStatus` — payment fidelity, orthogonal to lifecycle:
//   null       -> normal flow, no special signal
//   partial    -> 0 < paid < threshold (meaningful while status='processing')
//   overpaid   -> paid > threshold × (1 + over_bps/10000) (meaningful while
//                 status='completed')
//
// The two fields combine to express the full state surface a single 7-value
// enum used to encode:
//   (processing, partial)  — "some money in, not enough yet"
//   (completed, null)      — "exact match within tolerance"
//   (completed, overpaid)  — "fully paid plus extra"
//   (pending, null)        — "no activity at all"
export const InvoiceStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "expired",
  "canceled"
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const InvoiceExtraStatusSchema = z.enum(["partial", "overpaid"]);
export type InvoiceExtraStatus = z.infer<typeof InvoiceExtraStatusSchema>;

export const InvoiceIdSchema = z.string().uuid();
export type InvoiceId = Brand<z.infer<typeof InvoiceIdSchema>, "InvoiceId">;

// Per-family/per-chain receive-address entry on an invoice.
//
// Multi-family invoices have one row per accepted family for account-model
// chains (one EVM address valid across all 7 EVM chains, one Tron address
// across mainnet+Nile, etc.). UTXO is structurally different — BTC and
// LTC have different address shapes — so a universal invoice that accepts
// UTXO yields ONE row per UTXO chain the deployment supports
// (`bc1q…` + `ltc1q…` simultaneously).
//
// `chainId` is informational on EVM/Tron/Solana rows (the address works on
// every chainId in the family; we store the invoice's primary chainId so
// frontends have a label) and authoritative on UTXO rows (each chainId
// has its own derivation path → different addresses).
//
// Single-family invoices (legacy path) have one entry, denormalized into
// the invoice's top-level `chainId` + `receiveAddress` columns for back-compat.
export const InvoiceReceiveAddressSchema = z.object({
  family: ChainFamilySchema,
  // Numeric chainId of the address. For EVM/Tron/Solana this matches the
  // invoice's primary chainId (purely informational since the address is
  // chain-agnostic in those families). For UTXO this is the specific chain
  // (800/801/802/803) the address derives for.
  chainId: z.number().int().positive(),
  address: AddressSchema,
  // NULL for UTXO-family receive addresses (no pool — fresh-per-invoice
  // derivation via address_index_counters). Non-null on EVM/Tron/Solana.
  poolAddressId: z.string().uuid().nullable()
});
export type InvoiceReceiveAddress = z.infer<typeof InvoiceReceiveAddressSchema>;

export const InvoiceSchema = z.object({
  id: InvoiceIdSchema,
  merchantId: MerchantIdSchema,
  status: InvoiceStatusSchema,
  // Payment-fidelity signal, orthogonal to `status`. See InvoiceStatusSchema
  // doc-block for the (status, extraStatus) pairs.
  extraStatus: InvoiceExtraStatusSchema.nullable(),

  // Primary chain + receive address. For multi-family invoices, this is the
  // first family's values (for back-compat display). The authoritative
  // address set lives in `receiveAddresses[]`.
  chainId: ChainIdSchema,
  token: TokenSymbolSchema,
  receiveAddress: AddressSchema,
  addressIndex: z.number().int().nonnegative(),

  // Families this invoice accepts payment on. Defaults to
  // `[familyOf(chainId)]` when the caller doesn't specify — preserves
  // single-chain legacy semantics. Explicit `["evm","tron","solana"]`
  // enables multi-family: one receive address per family, same invoice.
  acceptedFamilies: z.array(ChainFamilySchema).min(1),
  receiveAddresses: z.array(InvoiceReceiveAddressSchema).min(1),

  // Amount the merchant asked for, in the token's raw units.
  requiredAmountRaw: AmountRawSchema,
  // Sum of confirmed inbound transfers to the receive address for this invoice.
  receivedAmountRaw: AmountRawSchema,

  // Fiat-referenced fields (optional; present when the merchant priced in fiat).
  fiatAmount: FiatAmountSchema.nullable(),
  fiatCurrency: FiatCurrencySchema.nullable(),
  // Snapshot of the token/fiat rate at invoice creation (decimal string).
  quotedRate: z.string().nullable(),

  // USD-pegged invoice amounts. When `amountUsd` is set the invoice is on the
  // "USD path" — detection converts each payment to USD via the rate-window
  // snapshot and aggregates into `paidUsd`. When the target is reached,
  // status flips to `confirmed`; when exceeded, `overpaid` with the delta in
  // `overpaidUsd`. Legacy single-token invoices leave `amountUsd` null and
  // keep using `receivedAmountRaw` ∈ tokens as before.
  amountUsd: z.string().nullable(),
  paidUsd: z.string(),                     // "0" for fresh invoices
  overpaidUsd: z.string(),                 // "0" unless status = overpaid
  // Unix-ms timestamp the current rate snapshot expires at. Null for legacy
  // invoices. Detection refreshes the window when it fires past expiry (see
  // rate-window.ts).
  rateWindowExpiresAt: z.date().nullable(),
  // Pinned rates for the current window, keyed by token symbol.
  // e.g. { "USDC": "1.00", "ETH": "2500.00" }. Null for legacy.
  rates: z.record(z.string()).nullable(),

  // Merchant-supplied opaque reference (e.g. cart id).
  externalId: z.string().max(256).nullable(),
  metadata: z.record(z.unknown()).nullable(),

  // Per-invoice webhook destination override. Echoed in API responses so
  // merchants can confirm what they configured. The matching secret is
  // write-only (encrypted at rest, never returned). When null, dispatch
  // falls back to the merchant-account webhook.
  webhookUrl: z.string().url().nullable(),

  // Payment tolerance, basis points. Snapshotted at create time from the
  // input override (if provided) or the merchant default. Always populated
  // (no inheritance at read-time).
  paymentToleranceUnderBps: z.number().int().min(0).max(2000),
  paymentToleranceOverBps: z.number().int().min(0).max(2000),

  // Confirmation count required for a transfer paying this invoice to flip
  // from `detected` to `confirmed`. Snapshotted at invoice create time —
  // resolves merchant.confirmation_thresholds_json[primary chainId] →
  // env-FINALITY_OVERRIDES → gateway per-chain default. Frozen for the
  // invoice's lifetime: merchant policy changes don't reshape in-flight
  // invoices. Applies to every accepted family (one threshold per invoice,
  // not per chain leg). Nullable for back-compat with pre-migration rows.
  confirmationThreshold: z.number().int().positive().nullable(),

  // Snapshot of merchant.confirmation_tiers_json at invoice create time,
  // parsed back into its object form for API responses. Each transfer
  // paying this invoice is evaluated against the tier list for
  // `${chainId}:${token}` — first matching rule's confirmations win;
  // on no match, falls back to the flat `confirmationThreshold` above.
  // NULL = no tiers configured.
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
  expiresAt: z.date(),
  confirmedAt: z.date().nullable(),
  updatedAt: z.date()
});
export type Invoice = z.infer<typeof InvoiceSchema> & { id: InvoiceId };
