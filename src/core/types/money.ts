import { z } from "zod";

// Decimal string of a fiat amount, e.g. "12.34". Never a JS number (float drift).
export const FiatAmountSchema = z.string().regex(/^\d+(\.\d+)?$/, "FiatAmount must be a positive decimal string");
export type FiatAmount = z.infer<typeof FiatAmountSchema>;

// Raw on-chain amount in the token's smallest unit, as a decimal string
// (e.g. "1000000" for 1 USDC at 6 decimals). Stored as TEXT in libSQL.
export const AmountRawSchema = z.string().regex(/^\d+$/, "AmountRaw must be a non-negative integer string");
export type AmountRaw = z.infer<typeof AmountRawSchema>;

// ISO 4217 currency code. Stored uppercase.
export const FiatCurrencySchema = z.string().length(3).regex(/^[A-Z]{3}$/);
export type FiatCurrency = z.infer<typeof FiatCurrencySchema>;

// Quoted price of 1 whole token in fiat, as a decimal string.
// e.g. { rate: "1.0003", at: Date } for USDC->USD.
export const RateSchema = z.object({
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  at: z.date()
});
export type Rate = z.infer<typeof RateSchema>;
