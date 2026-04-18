import { z } from "zod";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { ChainFamilySchema, ChainIdSchema, type ChainFamily } from "../types/chain.js";
import { chainSlug } from "../types/chain-registry.js";
import { AmountRawSchema, FiatAmountSchema, FiatCurrencySchema, formatRawAmount } from "../types/money.js";
import { MerchantIdSchema, PaymentToleranceBpsSchema } from "../types/merchant.js";
import type { Invoice, InvoiceId, InvoiceReceiveAddress } from "../types/invoice.js";
import { TokenSymbolSchema } from "../types/token.js";
import { findToken, TOKEN_REGISTRY } from "../types/token-registry.js";
import type { Transaction } from "../types/transaction.js";
import { findChainAdapter } from "./chain-lookup.js";
import { isUniqueViolation } from "./db-errors.js";
import { drizzleRowToInvoice, drizzleRowToTransaction, fetchInvoiceReceiveAddresses, loadInvoice } from "./mappers.js";
import { DomainError } from "../errors.js";
import { allocateForInvoice, releaseFromInvoice } from "./pool.service.js";
import { addUsd, snapshotRates, subUsd, tokenDecimalsFor, tokensForFamilies } from "./rate-window.js";
import { invoices, invoiceReceiveAddresses, merchants, transactions } from "../../db/schema.js";

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
    // Per-invoice webhook override. Both required together — passing one
    // without the other is rejected by the .refine below so we never sign
    // events with a key meant for a different endpoint. Omit both to fall
    // back to the merchant-account webhook.
    webhookUrl: z.string().url().optional(),
    webhookSecret: z.string().min(16).max(512).optional(),
    // Per-invoice payment tolerance override in basis points. Either or both
    // optional; omit to inherit the merchant default (snapshotted at create
    // time). See merchants.payment_tolerance_*_bps for the math semantics.
    paymentToleranceUnderBps: PaymentToleranceBpsSchema.optional(),
    paymentToleranceOverBps: PaymentToleranceBpsSchema.optional(),
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
  )
  .refine(
    (v) => (v.webhookUrl === undefined) === (v.webhookSecret === undefined),
    {
      message:
        "`webhookUrl` and `webhookSecret` must be provided together — one without the other would sign events with a mismatched key"
    }
  );
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceInputSchema>;

// ---- Operations ----

export async function createInvoice(deps: AppDeps, input: unknown): Promise<Invoice> {
  const parsed = CreateInvoiceInputSchema.parse(input);

  // 1. Merchant must exist + be active.
  const [merchant] = await deps.db
    .select({
      id: merchants.id,
      active: merchants.active,
      paymentToleranceUnderBps: merchants.paymentToleranceUnderBps,
      paymentToleranceOverBps: merchants.paymentToleranceOverBps
    })
    .from(merchants)
    .where(eq(merchants.id, parsed.merchantId))
    .limit(1);
  if (!merchant) {
    throw new InvoiceError("MERCHANT_NOT_FOUND", `Merchant not found: ${parsed.merchantId}`);
  }
  if (merchant.active !== 1) {
    throw new InvoiceError("MERCHANT_INACTIVE", `Merchant is inactive: ${parsed.merchantId}`);
  }

  // 1b. Idempotency: if the merchant has already created an invoice with
  //     this `external_id`, return the existing one (Stripe-style). The
  //     external_id is the merchant's own dedup key — usually their order
  //     number — so a retry of the same POST should be safe and return the
  //     same invoice. Doing this BEFORE pool allocation avoids burning a
  //     pool address per duplicate attempt. The race window between this
  //     SELECT and the INSERT below is closed by step 7's UNIQUE-violation
  //     fallback (same return semantics).
  if (parsed.externalId !== undefined) {
    const existing = await loadInvoiceByExternalId(deps, parsed.merchantId, parsed.externalId);
    if (existing !== null) return existing;
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

  // 6b. Encrypt the per-invoice webhook secret if one was provided. Stored
  //     ciphertext only; plaintext lives only in the request body and the
  //     decrypt-then-HMAC stack frame at dispatch time. The pair (URL +
  //     secret) is enforced by the input schema's refine — both NULL means
  //     fall back to the merchant default.
  const webhookSecretCiphertext =
    parsed.webhookSecret !== undefined
      ? await deps.secretsCipher.encrypt(parsed.webhookSecret)
      : null;

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
    webhookUrl: parsed.webhookUrl ?? null,
    webhookSecretCiphertext: webhookSecretCiphertext,
    paymentToleranceUnderBps:
      parsed.paymentToleranceUnderBps ?? merchant.paymentToleranceUnderBps,
    paymentToleranceOverBps:
      parsed.paymentToleranceOverBps ?? merchant.paymentToleranceOverBps,
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
  try {
    await deps.db.batch([invoiceInsertStmt, ...rxInsertStmts] as [
      typeof invoiceInsertStmt,
      ...typeof rxInsertStmts
    ]);
  } catch (err) {
    // Pool addresses were already flipped to 'allocated' against this brand-
    // new invoiceId; without the invoice row they'd leak. Release them on
    // any insert failure before either returning the duplicate or rethrowing.
    await releaseFromInvoice(deps, invoiceId);

    // Race with the step-1b idempotency check: another concurrent create
    // beat us to the unique index. Return the winner's invoice — same
    // semantics as the pre-check would have given.
    if (
      isUniqueViolation(err) &&
      parsed.externalId !== undefined
    ) {
      const winner = await loadInvoiceByExternalId(deps, parsed.merchantId, parsed.externalId);
      if (winner !== null) return winner;
    }
    throw err;
  }

  const invoice = drizzleRowToInvoice(invoiceInsert, receiveRows);

  await deps.events.publish({ type: "invoice.created", invoiceId: invoice.id, invoice, at: new Date(now) });

  return invoice;
}

// Lookup helper for the idempotency path: hydrates a full Invoice (including
// receive_addresses) from the (merchant_id, external_id) pair. Returns null
// when no match exists.
async function loadInvoiceByExternalId(
  deps: AppDeps,
  merchantId: string,
  externalId: string
): Promise<Invoice | null> {
  const [row] = await deps.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.merchantId, merchantId), eq(invoices.externalId, externalId)))
    .limit(1);
  if (!row) return null;
  const addresses = await fetchInvoiceReceiveAddresses(deps, row.id);
  return drizzleRowToInvoice(row, addresses);
}

export async function getInvoice(deps: AppDeps, invoiceId: InvoiceId): Promise<Invoice | null> {
  return loadInvoice(deps, invoiceId);
}

// Per-transaction view returned in the invoice GET breakdown. Strictly a
// projection of the `transactions` row enriched with derived fields
// (decimal-formatted amount, chain slug). All statuses are returned —
// merchant UIs can filter; debugging needs `reverted` / `orphaned` rows.
export interface InvoiceTransactionDetail {
  id: string;
  txHash: string;
  logIndex: number | null;
  chainId: number;
  // Short slug like "ethereum" / "tron" / "solana"; null when the chainId is
  // not in the static registry (defensive — every wired chain should be).
  chain: string | null;
  token: string;
  fromAddress: string;
  toAddress: string;
  // Raw on-chain integer string (e.g. "1000000" for 1 USDC). Stable, never lossy.
  amountRaw: string;
  // Human-readable decimal (e.g. "1" / "0.04"). Convenience for UIs that
  // would otherwise repeat the BigInt math; loses no information vs amountRaw.
  amount: string;
  // USD valuation pinned at detection time. null on legacy single-token
  // invoices and on rows the oracle couldn't price.
  amountUsd: string | null;
  usdRate: string | null;
  status: Transaction["status"];
  confirmations: number;
  blockNumber: number | null;
  detectedAt: string;
  confirmedAt: string | null;
}

// USD-axis breakdown for USD-path invoices. All fields null on legacy
// single-token invoices (the merchant works in raw token units there;
// `requiredAmountRaw` / `receivedAmountRaw` already carry that info).
export interface InvoiceAmountsBreakdown {
  requiredUsd: string | null;
  // Sum of `amountUsd` across CONFIRMED contributing transactions. Mirrors
  // what `recomputeUsdInvoice` writes into `paid_usd`, recomputed on read so
  // GET reflects the truth even if a future bug skips a recompute call.
  confirmedUsd: string | null;
  // Sum across `detected` transactions — money seen on chain but not yet
  // past the confirmation threshold. Useful for "X waiting to confirm" UI.
  confirmingUsd: string | null;
  // max(requiredUsd - confirmedUsd, 0). What the payer still owes.
  remainingUsd: string | null;
  // max(confirmedUsd - requiredUsd, 0). What was paid above target.
  overpaidUsd: string | null;
}

export interface InvoiceDetails {
  invoice: Invoice;
  amounts: InvoiceAmountsBreakdown;
  transactions: readonly InvoiceTransactionDetail[];
}

// Hydrated GET surface: invoice + USD breakdown + every transaction tied to
// the invoice (all statuses). One extra query vs. plain getInvoice. Merchants
// use this for the "show me everything about this invoice" panel; debugging
// uses it to see reverted / orphaned rows that paid_usd intentionally hides.
export async function getInvoiceDetails(
  deps: AppDeps,
  invoiceId: InvoiceId
): Promise<InvoiceDetails | null> {
  const invoice = await loadInvoice(deps, invoiceId);
  if (!invoice) return null;

  const txRows = await deps.db
    .select()
    .from(transactions)
    .where(eq(transactions.invoiceId, invoiceId))
    .orderBy(asc(transactions.detectedAt));
  const txs = txRows.map(drizzleRowToTransaction);

  const txDetails: InvoiceTransactionDetail[] = txs.map((tx) => {
    const decimals = tokenDecimalsFor(tx.chainId, tx.token);
    return {
      id: tx.id,
      txHash: tx.txHash,
      logIndex: tx.logIndex,
      chainId: tx.chainId,
      chain: chainSlug(tx.chainId),
      token: tx.token,
      fromAddress: tx.fromAddress,
      toAddress: tx.toAddress,
      amountRaw: tx.amountRaw,
      // decimals null only when the chainId/token pair isn't recognised at
      // all — extremely unusual since detection itself uses tokenDecimalsFor.
      // Falling back to amountRaw keeps the field populated for debugging.
      amount: decimals === null ? tx.amountRaw : formatRawAmount(tx.amountRaw, decimals),
      amountUsd: tx.amountUsd,
      usdRate: tx.usdRate,
      status: tx.status,
      confirmations: tx.confirmations,
      blockNumber: tx.blockNumber,
      detectedAt: tx.detectedAt.toISOString(),
      confirmedAt: tx.confirmedAt === null ? null : tx.confirmedAt.toISOString()
    };
  });

  const amounts = computeAmountsBreakdown(invoice, txs);

  return { invoice, amounts, transactions: txDetails };
}

// Recompute the USD-axis amounts from the stored transactions. We read
// rather than trusting `invoice.paidUsd` so the GET breakdown is always
// internally consistent with the transactions array shown beside it; the
// stored column stays the authoritative state-machine input.
function computeAmountsBreakdown(
  invoice: Invoice,
  txs: readonly Transaction[]
): InvoiceAmountsBreakdown {
  if (invoice.amountUsd === null) {
    return {
      requiredUsd: null,
      confirmedUsd: null,
      confirmingUsd: null,
      remainingUsd: null,
      overpaidUsd: null
    };
  }
  let confirmedUsd = "0.00";
  let confirmingUsd = "0.00";
  for (const tx of txs) {
    if (tx.amountUsd === null) continue;
    if (tx.status === "confirmed") confirmedUsd = addUsd(confirmedUsd, tx.amountUsd);
    else if (tx.status === "detected") confirmingUsd = addUsd(confirmingUsd, tx.amountUsd);
    // reverted / orphaned: excluded — they never count toward owed/overpaid.
  }
  const remainingUsd = subUsd(invoice.amountUsd, confirmedUsd);
  const overpaidUsd = subUsd(confirmedUsd, invoice.amountUsd);
  return {
    requiredUsd: invoice.amountUsd,
    confirmedUsd,
    confirmingUsd,
    remainingUsd,
    overpaidUsd
  };
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

export interface SweepExpiredInvoicesResult {
  expired: number;
}

// Cron-driven expiration sweeper. Transitions every `created`/`partial` row
// past its expiresAt to `expired`, then publishes invoice.expired per row so
// downstream subscribers (pool release, webhook dispatch) fire. Without this,
// expired invoices sit in `partial` forever — payment polling skips them
// (poll-payments.ts gates on expiresAt > now), but their pool addresses never
// return to rotation and the merchant never receives the lifecycle webhook.
export async function sweepExpiredInvoices(deps: AppDeps): Promise<SweepExpiredInvoicesResult> {
  const now = deps.clock.now().getTime();
  const updated = await deps.db
    .update(invoices)
    .set({ status: "expired", updatedAt: now })
    .where(and(inArray(invoices.status, ["created", "partial"]), lte(invoices.expiresAt, now)))
    .returning();
  if (updated.length === 0) return { expired: 0 };

  for (const row of updated) {
    try {
      const addresses = await fetchInvoiceReceiveAddresses(deps, row.id);
      const invoice = drizzleRowToInvoice(row, addresses);
      await deps.events.publish({
        type: "invoice.expired",
        invoiceId: invoice.id,
        invoice,
        at: new Date(now)
      });
    } catch (err) {
      deps.logger.error("invoice.expired publish failed during sweep", {
        invoiceId: row.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { expired: updated.length };
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
