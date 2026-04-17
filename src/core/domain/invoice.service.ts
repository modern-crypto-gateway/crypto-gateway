import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { ChainFamilySchema, ChainIdSchema, type ChainFamily } from "../types/chain.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema } from "../types/money.js";
import { MerchantIdSchema } from "../types/merchant.js";
import type { Invoice, InvoiceId, InvoiceReceiveAddress } from "../types/invoice.js";
import { TokenSymbolSchema } from "../types/token.js";
import { findToken, TOKEN_REGISTRY } from "../types/token-registry.js";
import { findChainAdapter } from "./chain-lookup.js";
import { drizzleRowToInvoice, fetchInvoiceReceiveAddresses, loadInvoice } from "./mappers.js";
import { DomainError } from "../errors.js";
import { allocateForInvoice } from "./pool.service.js";
import { snapshotRates, tokensForFamilies } from "./rate-window.js";
import { invoices, invoiceReceiveAddresses, merchants } from "../../db/schema.js";

// ---- Input validation ----

export const CreateInvoiceInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    chainId: ChainIdSchema,
    token: TokenSymbolSchema,
    // Three mutually-compatible pricing modes:
    //   - `amountUsd`: USD-pegged. Payments in any accepted-family token
    //     convert via the pinned rate-window snapshot.
    //   - `amountRaw`: exact token amount. Single-token, payer must pay
    //     in that token. Legacy.
    //   - `fiatAmount + fiatCurrency`: single-token, amount derived at
    //     creation via oracle.fiatToTokenAmount. Legacy.
    // `.refine` below enforces exactly-one-is-present.
    amountUsd: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
    fiatAmount: FiatAmountSchema.optional(),
    fiatCurrency: FiatCurrencySchema.optional(),
    amountRaw: AmountRawSchema.optional(),
    // Multi-family acceptance. When set, the invoice gets one receive address
    // per family. Omitted = single-family, derived from `chainId`'s family.
    acceptedFamilies: z.array(ChainFamilySchema).min(1).optional(),
    externalId: z.string().max(256).optional(),
    metadata: z.record(z.unknown()).optional(),
    // Default 30 minutes. Hard ceiling at 24 hours — the scheduler promotes
    // long-expired invoices and merchants who need days-long expiries are
    // doing something unusual.
    expiresInMinutes: z.number().int().min(1).max(60 * 24).default(30)
  })
  .refine(
    (v) => {
      // Exactly one pricing mode. All-three-absent rejected; combinations
      // rejected so the path the invoice takes is unambiguous at read time.
      const modes =
        (v.amountUsd !== undefined ? 1 : 0) +
        (v.amountRaw !== undefined ? 1 : 0) +
        (v.fiatAmount !== undefined || v.fiatCurrency !== undefined ? 1 : 0);
      return modes === 1;
    },
    {
      message:
        "Provide EXACTLY ONE of: `amountUsd` (USD-pegged, any-token), `amountRaw` (legacy single-token), or `fiatAmount` + `fiatCurrency` (legacy fiat-quoted)"
    }
  )
  .refine(
    (v) => v.fiatAmount === undefined || v.fiatCurrency !== undefined,
    { message: "`fiatAmount` requires `fiatCurrency`" }
  );
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceInputSchema>;

// ---- Operations ----

export async function createInvoice(deps: AppDeps, input: unknown): Promise<Invoice> {
  const parsed = CreateInvoiceInputSchema.parse(input);

  // 1. Merchant must exist + be active.
  const [merchant] = await deps.db
    .select({ id: merchants.id, active: merchants.active })
    .from(merchants)
    .where(eq(merchants.id, parsed.merchantId))
    .limit(1);
  if (!merchant) {
    throw new InvoiceError("MERCHANT_NOT_FOUND", `Merchant not found: ${parsed.merchantId}`);
  }
  if (merchant.active !== 1) {
    throw new InvoiceError("MERCHANT_INACTIVE", `Merchant is inactive: ${parsed.merchantId}`);
  }

  // 2. Token must be registered for this chain. For the USD path this is
  //    only a sanity check that the merchant's `token` + `chainId` pair is
  //    real; detection accepts payments in ANY registered token on the
  //    accepted families regardless.
  const token = findToken(parsed.chainId, parsed.token);
  if (!token) {
    throw new InvoiceError("TOKEN_NOT_SUPPORTED", `Token ${parsed.token} not supported on chain ${parsed.chainId}`);
  }

  // 3. Compute required raw amount for legacy paths (amountRaw / fiatAmount).
  //    USD-path invoices set `amountUsd` and leave `requiredAmountRaw` as "0"
  //    — detection converts payments to USD using the rate-window snapshot
  //    captured in step 6 below.
  let requiredAmountRaw: string;
  let quotedRate: string | null = null;
  if (parsed.amountRaw !== undefined) {
    requiredAmountRaw = parsed.amountRaw;
  } else if (parsed.fiatAmount !== undefined) {
    const conversion = await deps.priceOracle.fiatToTokenAmount(
      parsed.fiatAmount,
      parsed.token,
      parsed.fiatCurrency!,
      token.decimals
    );
    requiredAmountRaw = conversion.amountRaw;
    quotedRate = conversion.rate;
  } else {
    // USD path: required raw amount isn't meaningful (payment can land in
    // any accepted token). Store "0" so the column stays populated; the
    // authoritative target is `amount_usd`.
    requiredAmountRaw = "0";
  }

  // 4. Resolve the family set for this invoice.
  //      - `acceptedFamilies` explicit → exactly those families.
  //      - omitted → infer `[familyOf(chainId)]` (single-family legacy).
  //    For each family in the set, validate the requested token is
  //    registered on at least one of that family's chains — an invoice for
  //    "USDC on Tron family" requires USDC on Tron mainnet (or Nile). If
  //    none of a family's chains have the token, the invoice would be
  //    unfulfillable on that family, so reject at creation time.
  const primaryChainAdapter = findChainAdapter(deps, parsed.chainId);
  const acceptedFamilies: ChainFamily[] =
    parsed.acceptedFamilies ?? [primaryChainAdapter.family];

  for (const family of acceptedFamilies) {
    if (!familyHasToken(family, parsed.token)) {
      throw new InvoiceError(
        "TOKEN_NOT_SUPPORTED",
        `Token ${parsed.token} is not registered on any chain in family '${family}'`
      );
    }
  }

  // 5. Allocate one pool row per accepted family. The `primary` family
  //    (from chainId) lands first, so its address is what goes into the
  //    legacy `invoices.receive_address` column for back-compat. Invoice ID
  //    generated up-front so allocateForInvoice can write it into the pool
  //    rows.
  const now = deps.clock.now().getTime();
  const invoiceId = globalThis.crypto.randomUUID();
  const primaryFamily = primaryChainAdapter.family;
  const familyOrder: ChainFamily[] = [
    primaryFamily,
    ...acceptedFamilies.filter((f) => f !== primaryFamily)
  ];
  const receiveRows: InvoiceReceiveAddress[] = [];
  let primaryAddress: string | null = null;
  let primaryAddressIndex = 0;
  for (const family of familyOrder) {
    const familyAdapter = deps.chains.find((c) => c.family === family);
    if (!familyAdapter) {
      throw new InvoiceError(
        "TOKEN_NOT_SUPPORTED",
        `No chain adapter wired for family '${family}'. Invoice creation requires all accepted families to be configured on the gateway.`
      );
    }
    const allocated = await allocateForInvoice(deps, invoiceId, family);
    const canonical = familyAdapter.canonicalizeAddress(allocated.address);
    receiveRows.push({
      family,
      address: canonical as InvoiceReceiveAddress["address"],
      poolAddressId: allocated.id
    });
    if (family === primaryFamily) {
      primaryAddress = canonical;
      primaryAddressIndex = allocated.addressIndex;
    }
  }
  if (primaryAddress === null) {
    throw new Error("Invariant: primary family allocation missing");
  }

  // 6. For USD-path invoices, snapshot the rate window now. Covers every
  //    token registered in the accepted families + the family natives the
  //    oracle can quote. Rates pinned for 10 minutes; detection refreshes
  //    when it fires past expiry. Legacy invoices skip this entirely.
  let amountUsd: string | null = null;
  let ratesJson: string | null = null;
  let rateWindowExpiresAt: number | null = null;
  if (parsed.amountUsd !== undefined) {
    amountUsd = parsed.amountUsd;
    const snapshot = await snapshotRates(deps, tokensForFamilies(acceptedFamilies));
    ratesJson = JSON.stringify(snapshot.rates);
    rateWindowExpiresAt = snapshot.expiresAt;
  }

  // 7. Insert the invoice row (denormalizes the primary family's address)
  //    and the per-family join rows in a single batch so a partial write
  //    can't leave the invoice unreachable for detection.
  const expiresAt = now + parsed.expiresInMinutes * 60_000;
  const metadataJson = parsed.metadata !== undefined ? JSON.stringify(parsed.metadata) : null;
  const invoiceInsert = {
    id: invoiceId,
    merchantId: parsed.merchantId,
    status: "created" as const,
    chainId: parsed.chainId,
    token: parsed.token,
    receiveAddress: primaryAddress,
    addressIndex: primaryAddressIndex,
    requiredAmountRaw: requiredAmountRaw,
    receivedAmountRaw: "0",
    fiatAmount: parsed.fiatAmount ?? null,
    fiatCurrency: parsed.fiatCurrency ?? null,
    quotedRate: quotedRate,
    externalId: parsed.externalId ?? null,
    metadataJson: metadataJson,
    acceptedFamilies: JSON.stringify(acceptedFamilies),
    amountUsd: amountUsd,
    paidUsd: "0",
    overpaidUsd: "0",
    rateWindowExpiresAt: rateWindowExpiresAt,
    ratesJson: ratesJson,
    createdAt: now,
    expiresAt: expiresAt,
    confirmedAt: null,
    updatedAt: now
  };
  const invoiceInsertStmt = deps.db.insert(invoices).values(invoiceInsert);
  const rxInsertStmts = receiveRows.map((rx) =>
    deps.db.insert(invoiceReceiveAddresses).values({
      invoiceId,
      family: rx.family,
      address: rx.address,
      poolAddressId: rx.poolAddressId,
      createdAt: now
    })
  );
  await deps.db.batch([invoiceInsertStmt, ...rxInsertStmts] as [
    typeof invoiceInsertStmt,
    ...typeof rxInsertStmts
  ]);

  const invoice = drizzleRowToInvoice(invoiceInsert, receiveRows);

  await deps.events.publish({ type: "invoice.created", invoiceId: invoice.id, invoice, at: new Date(now) });

  return invoice;
}

export async function getInvoice(deps: AppDeps, invoiceId: InvoiceId): Promise<Invoice | null> {
  return loadInvoice(deps, invoiceId);
}

export async function expireInvoice(deps: AppDeps, invoiceId: InvoiceId): Promise<Invoice> {
  const now = deps.clock.now().getTime();
  const [row] = await deps.db
    .update(invoices)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, ["created", "partial"])))
    .returning();
  if (!row) {
    throw new InvoiceError(
      "EXPIRE_NOT_ALLOWED",
      `Invoice ${invoiceId} cannot be expired — either it does not exist or it is already in a terminal state`
    );
  }
  const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceId);
  const invoice = drizzleRowToInvoice(row, addresses);
  await deps.events.publish({ type: "invoice.expired", invoiceId: invoice.id, invoice, at: new Date(now) });
  return invoice;
}

// Returns true when at least one chain in the family has `token` registered.
// Used at invoice creation to reject "USDC on Solana" before Solana SPL
// tokens are in the registry, for instance.
function familyHasToken(family: ChainFamily, token: string): boolean {
  for (const entry of TOKEN_REGISTRY) {
    if (entry.symbol !== token) continue;
    const adapterFamily = familyForChainId(entry.chainId);
    if (adapterFamily === family) return true;
  }
  return false;
}

// Small helper mapping chain ids to their families. Mirrors the adapter's
// family property without requiring an adapter lookup — the token registry
// is already loaded in memory, and we only need the family label.
function familyForChainId(chainId: number): ChainFamily | null {
  if (chainId >= 900 && chainId <= 901) return "solana";
  if (chainId === 728126428 || chainId === 3448148188) return "tron";
  return "evm";
}

// ---- Typed domain error ----

export type InvoiceErrorCode =
  | "MERCHANT_NOT_FOUND"
  | "MERCHANT_INACTIVE"
  | "TOKEN_NOT_SUPPORTED"
  | "EXPIRE_NOT_ALLOWED";

// HTTP status per code lives here (next to the codes themselves) rather than
// in the route's handleError — routes shouldn't reverse-engineer semantics
// from a code name. Note: POOL_EXHAUSTED (503) is thrown by pool.service as
// a PoolExhaustedError; it's a DomainError so renderError handles it
// uniformly — no need to duplicate the code here.
const INVOICE_ERROR_HTTP_STATUS: Readonly<Record<InvoiceErrorCode, number>> = {
  MERCHANT_NOT_FOUND: 404,
  MERCHANT_INACTIVE: 403,
  TOKEN_NOT_SUPPORTED: 400,
  EXPIRE_NOT_ALLOWED: 409
};

export class InvoiceError extends DomainError {
  declare readonly code: InvoiceErrorCode;
  constructor(code: InvoiceErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, INVOICE_ERROR_HTTP_STATUS[code], details);
    this.name = "InvoiceError";
  }
}
