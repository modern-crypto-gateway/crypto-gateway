import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainFamilySchema, ChainIdSchema } from "./chain.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema } from "./money.js";
import { MerchantIdSchema } from "./merchant.js";
import { TokenSymbolSchema } from "./token.js";

// Order lifecycle:
//   created   -> awaiting first detection (or re-opened after all contributing txs reverted)
//   partial   -> transfers seen sum to < required amount; timer still running
//   detected  -> exact-or-over amount seen, awaiting N confirmations
//   confirmed -> finalized; merchant webhook fired
//   expired   -> expiry window elapsed without sufficient funds
//   canceled  -> merchant canceled before confirmation
export const OrderStatusSchema = z.enum([
  "created",
  "partial",
  "detected",
  "confirmed",
  "expired",
  "canceled"
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderIdSchema = z.string().uuid();
export type OrderId = Brand<z.infer<typeof OrderIdSchema>, "OrderId">;

// Per-family receive-address entry on an order. Multi-family orders have
// one row per accepted family (e.g. one EVM address + one Tron address).
// Single-family orders (legacy path) have exactly one entry, denormalized
// into the order's `chainId` + `receiveAddress` columns for back-compat.
export const OrderReceiveAddressSchema = z.object({
  family: ChainFamilySchema,
  address: AddressSchema,
  poolAddressId: z.string().uuid()
});
export type OrderReceiveAddress = z.infer<typeof OrderReceiveAddressSchema>;

export const OrderSchema = z.object({
  id: OrderIdSchema,
  merchantId: MerchantIdSchema,
  status: OrderStatusSchema,

  // Primary chain + receive address. For multi-family orders, this is the
  // first family's values (for back-compat display). The authoritative
  // address set lives in `receiveAddresses[]`.
  chainId: ChainIdSchema,
  token: TokenSymbolSchema,
  receiveAddress: AddressSchema,
  addressIndex: z.number().int().nonnegative(),

  // Families this order accepts payment on. Defaults to
  // `[familyOf(chainId)]` when the caller doesn't specify — preserves
  // single-chain legacy semantics. Explicit `["evm","tron","solana"]`
  // enables multi-family: one receive address per family, same order.
  acceptedFamilies: z.array(ChainFamilySchema).min(1),
  receiveAddresses: z.array(OrderReceiveAddressSchema).min(1),

  // Amount the merchant asked for, in the token's raw units.
  requiredAmountRaw: AmountRawSchema,
  // Sum of confirmed inbound transfers to the receive address for this order.
  receivedAmountRaw: AmountRawSchema,

  // Fiat-referenced fields (optional; present when the merchant priced in fiat).
  fiatAmount: FiatAmountSchema.nullable(),
  fiatCurrency: FiatCurrencySchema.nullable(),
  // Snapshot of the token/fiat rate at order creation (decimal string).
  quotedRate: z.string().nullable(),

  // Merchant-supplied opaque reference (e.g. cart id).
  externalId: z.string().max(256).nullable(),
  metadata: z.record(z.unknown()).nullable(),

  createdAt: z.date(),
  expiresAt: z.date(),
  confirmedAt: z.date().nullable(),
  updatedAt: z.date()
});
export type Order = z.infer<typeof OrderSchema> & { id: OrderId };
