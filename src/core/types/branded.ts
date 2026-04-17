// Brand helper for opaque string IDs. `InvoiceId` is structurally a string but
// cannot be passed where `MerchantId` is expected, catching id-confusion bugs
// at compile time without runtime cost.
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };
