import { z } from "zod";
import type { Brand } from "./branded.js";
import { AddressSchema, ChainIdSchema } from "./chain.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema } from "./money.js";
import { MerchantIdSchema } from "./merchant.js";
import { TokenSymbolSchema } from "./token.js";

// Order lifecycle:
//   created  -> awaiting first detection
//   pending  -> at least one matching transfer seen, not yet confirmed
//   partial  -> transfers seen sum to < required amount; timer still running
//   detected -> exact-or-over amount seen, awaiting N confirmations
//   confirmed -> finalized; merchant webhook fired
//   expired   -> expiry window elapsed without sufficient funds
//   canceled  -> merchant canceled before confirmation
export const OrderStatusSchema = z.enum([
  "created",
  "pending",
  "partial",
  "detected",
  "confirmed",
  "expired",
  "canceled"
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderIdSchema = z.string().uuid();
export type OrderId = Brand<z.infer<typeof OrderIdSchema>, "OrderId">;

export const OrderSchema = z.object({
  id: OrderIdSchema,
  merchantId: MerchantIdSchema,
  status: OrderStatusSchema,

  chainId: ChainIdSchema,
  token: TokenSymbolSchema,
  // Receive address is an HD-derived address owned by the gateway. `addressIndex`
  // is the derivation index; the private key is re-derived on demand, never stored.
  receiveAddress: AddressSchema,
  addressIndex: z.number().int().nonnegative(),

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
