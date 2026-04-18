import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainFamilySchema, ChainIdSchema } from "./chain.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema } from "./money.js";
import { MerchantIdSchema } from "./merchant.js";
import { TokenSymbolSchema } from "./token.js";

// Invoice lifecycle:
//   created   -> awaiting first detection (or re-opened after all contributing txs reverted)
//   partial   -> transfers seen sum to < required amount; timer still running
//   detected  -> exact-or-over amount seen, awaiting N confirmations
//   confirmed -> finalized; merchant webhook fired
//   overpaid  -> reached the USD target AND the aggregate went OVER — customer
//                sent more than we asked for. Distinct from `confirmed` so
//                merchants can surface a refund / credit prompt without parsing
//                amounts.
//   expired   -> expiry window elapsed without sufficient funds
//   canceled  -> merchant canceled before confirmation
export const InvoiceStatusSchema = z.enum([
  "created",
  "partial",
  "detected",
  "confirmed",
  "overpaid",
  "expired",
  "canceled"
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const InvoiceIdSchema = z.string().uuid();
export type InvoiceId = Brand<z.infer<typeof InvoiceIdSchema>, "InvoiceId">;

// Per-family receive-address entry on an invoice. Multi-family invoices have
// one row per accepted family (e.g. one EVM address + one Tron address).
// Single-family invoices (legacy path) have exactly one entry, denormalized
// into the invoice's `chainId` + `receiveAddress` columns for back-compat.
export const InvoiceReceiveAddressSchema = z.object({
  family: ChainFamilySchema,
  address: AddressSchema,
  poolAddressId: z.string().uuid()
});
export type InvoiceReceiveAddress = z.infer<typeof InvoiceReceiveAddressSchema>;

export const InvoiceSchema = z.object({
  id: InvoiceIdSchema,
  merchantId: MerchantIdSchema,
  status: InvoiceStatusSchema,

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

  createdAt: z.date(),
  expiresAt: z.date(),
  confirmedAt: z.date().nullable(),
  updatedAt: z.date()
});
export type Invoice = z.infer<typeof InvoiceSchema> & { id: InvoiceId };
