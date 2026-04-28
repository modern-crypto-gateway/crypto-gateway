import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, type SQL } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import { ChainFamilySchema, ChainIdSchema, type ChainFamily, type ChainId } from "../types/chain.js";
import type { ChainAdapter } from "../ports/chain.port.js";
import { chainEntry, chainSlug } from "../types/chain-registry.js";
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
import { allocateUtxoAddress } from "./utxo-address-allocator.js";
import { addUsd, snapshotRates, subUsd, tokenDecimalsFor, tokensForFamilies } from "./rate-window.js";
import { resolveMerchantConfirmationThreshold } from "./payment-config.js";
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
      paymentToleranceOverBps: merchants.paymentToleranceOverBps,
      confirmationThresholdsJson: merchants.confirmationThresholdsJson,
      confirmationTiersJson: merchants.confirmationTiersJson
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
  //
  //    Token-availability validation depends on the pricing mode:
  //
  //    - LEGACY single-token (`amountRaw`, `fiatAmount + fiatCurrency`):
  //      every accepted family must have the requested token registered,
  //      because payments MUST come in that exact token. A family whose
  //      chains don't carry the token is structurally unfulfillable.
  //
  //    - USD-pegged universal (`amountUsd`): payments in ANY token
  //      registered on ANY accepted family count toward the USD target via
  //      the rate-window snapshot. The `token` on the request is just a
  //      display label for the invoice's primary chain; it doesn't need to
  //      exist on every accepted family. We only require it on the PRIMARY
  //      family (the one matching `chainId`) so the merchant's "primary
  //      token on primary chain" assertion is at least coherent. Other
  //      families can pay in their natives + stables freely.
  const primaryChainAdapter = findChainAdapter(deps, parsed.chainId);
  const acceptedFamilies: ChainFamily[] =
    parsed.acceptedFamilies ?? [primaryChainAdapter.family];
  const isUsdPegged = parsed.amountUsd !== undefined;

  if (isUsdPegged) {
    // Only the primary family needs the token. UTXO/Tron/Solana/etc. as
    // non-primary accepted families don't need USDC (or whatever) — they'll
    // accept their own natives + stables and convert to USD.
    if (!familyHasToken(primaryChainAdapter.family, parsed.token)) {
      throw new InvoiceError(
        "TOKEN_NOT_SUPPORTED",
        `Token ${parsed.token} is not registered on any chain in family '${primaryChainAdapter.family}' (the primary chain's family). USD-pegged invoices accept any token on any accepted family at the rate-window rate; the request's primary token must at least exist on the primary chain.`
      );
    }
  } else {
    for (const family of acceptedFamilies) {
      if (!familyHasToken(family, parsed.token)) {
        throw new InvoiceError(
          "TOKEN_NOT_SUPPORTED",
          `Token ${parsed.token} is not registered on any chain in family '${family}'. Legacy single-token invoices (amountRaw / fiatAmount) require the token on every accepted family. Switch to USD-pegged (amountUsd) to accept any token across families.`
        );
      }
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
  // Single try wraps allocation, rate snapshot, secret encryption, and batch
  // insert. ANY throw between the first allocateForInvoice and the batch
  // insert would otherwise orphan pool rows (we saw real orphans in prod when
  // the batch insert hit a unique violation; the same leak existed for
  // snapshotRates / secretsCipher.encrypt failures and partial multi-family
  // allocation failures, which the previous narrower try did not cover).
  // The compensating release is idempotent: releaseFromInvoice updates rows
  // by allocatedToInvoiceId, so partial allocations (e.g. 2 of 3 families)
  // get released the same way as full ones.
  try {
    for (const family of familyOrder) {
      // Resolve the set of adapters to allocate addresses from for THIS family.
      //
      //   - EVM / Tron / Solana: one adapter per family handles every chainId,
      //     and addresses are chain-agnostic across the family — so we
      //     allocate exactly ONE address. The `chainId` recorded on the row
      //     is the invoice's primary chainId (for the primary family) or a
      //     conventional default (chainAdapter.supportedChainIds[0]) for
      //     non-primary families.
      //
      //   - UTXO (primary): allocate one address on `parsed.chainId`'s chain
      //     adapter exclusively. The merchant explicitly chose the chain.
      //
      //   - UTXO (non-primary on a non-UTXO-primary universal invoice):
      //     allocate one address per REGISTERED UTXO chain (e.g. BTC + LTC
      //     simultaneously, plus testnets if the deployment registers them).
      //     Each lands as its own row keyed by `(invoice_id, family='utxo',
      //     chain_id)`. This is the "$10 USD invoice payable in BTC OR LTC"
      //     workflow — the customer picks which UTXO chain to pay on, the
      //     gateway accepts whichever address gets funded first.
      const adaptersForFamily = resolveAllocationAdaptersForFamily({
        family,
        primaryFamily,
        primaryChainAdapter,
        primaryChainId: parsed.chainId,
        chains: deps.chains
      });
      if (adaptersForFamily.length === 0) {
        throw new InvoiceError(
          "TOKEN_NOT_SUPPORTED",
          `No chain adapter wired for family '${family}'. Invoice creation requires all accepted families to be configured on the gateway.`
        );
      }

      for (const { adapter, chainId } of adaptersForFamily) {
        // UTXO family bypasses the address pool entirely — privacy heuristics
        // on Bitcoin/Litecoin require non-reuse, and BIP84 derivation is
        // cheap, so each invoice mints a fresh address from the per-chain
        // monotonic counter. EVM/Tron/Solana keep using the existing pool path.
        let canonical: string;
        let addressIndex: number;
        let poolAddressId: string | null;
        if (family === "utxo") {
          const seed = deps.secrets.getRequired("MASTER_SEED");
          const allocated = await allocateUtxoAddress(deps, adapter, chainId, seed);
          canonical = adapter.canonicalizeAddress(allocated.address);
          addressIndex = allocated.addressIndex;
          poolAddressId = null;
        } else {
          const allocated = await allocateForInvoice(deps, invoiceId, family);
          canonical = adapter.canonicalizeAddress(allocated.address);
          addressIndex = allocated.addressIndex;
          poolAddressId = allocated.id;
        }
        receiveRows.push({
          family,
          chainId,
          address: canonical as InvoiceReceiveAddress["address"],
          poolAddressId
        });
        // Only the PRIMARY family's primary chain populates the legacy
        // denormalized columns. For UTXO-primary that's the chosen UTXO
        // chain; for EVM/Tron/Solana primary it's parsed.chainId.
        if (family === primaryFamily && chainId === parsed.chainId) {
          primaryAddress = canonical;
          primaryAddressIndex = addressIndex;
        }
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
    // Snapshot the confirmation threshold for THIS invoice. Resolution:
    // merchant per-chain JSON > env override > chain default. Frozen for
    // the invoice's lifetime — merchant policy edits don't reshape in-flight
    // invoices. For multi-family invoices, the same value applies regardless
    // of which family ultimately receives the payment (merchant policy is
    // per-invoice, not per-leg).
    const confirmationThresholdSnapshot = resolveMerchantConfirmationThreshold(
      parsed.chainId,
      merchant.confirmationThresholdsJson,
      deps.confirmationThresholds
    );
    const invoiceInsert = {
      id: invoiceId,
      merchantId: parsed.merchantId,
      status: "pending" as const,
      extraStatus: null,
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
      confirmationThreshold: confirmationThresholdSnapshot,
      // Snapshot the WHOLE merchant tier map verbatim. Each transfer paying
      // this invoice can land in a different (chainId, token) tier; storing
      // the full map lets the confirm-sweep look up per-transfer without
      // re-reading the merchant row. Frozen at create time — merchant edits
      // don't reshape in-flight invoices.
      confirmationTiersJson: merchant.confirmationTiersJson,
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
        chainId: rx.chainId,
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
  } catch (err) {
    // Compensating release: any throw above leaves zero or more pool rows
    // tagged with this invoiceId but no matching invoice row. Release them
    // before returning the duplicate or rethrowing. Pass merchantId so the
    // cooldown stamp matches what a successful release would write — a
    // late payment that arrives despite the failed create still parks the
    // address for this merchant rather than handing it to the next caller.
    await releaseFromInvoice(deps, invoiceId, { merchantId: parsed.merchantId });

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

// ---- List / filter ----

// Hard ceiling keeps a single call from pulling the whole merchant's history —
// large page sizes stress both the `receive_addresses` hydration (one extra
// batch read per page) and the caller's JSON parser. Callers needing more
// either paginate via `offset` or narrow with filters.
const LIST_INVOICES_MAX_LIMIT = 100;

export const ListInvoicesInputSchema = z
  .object({
    merchantId: MerchantIdSchema,
    // Comma-separated in the HTTP layer; the schema accepts either an array or
    // a single status. Empty array = no filter.
    status: z.array(z.enum(["pending", "processing", "completed", "expired", "canceled"])).optional(),
    chainId: ChainIdSchema.optional(),
    token: TokenSymbolSchema.optional(),
    // Merchant-supplied dedup / order key. Exact match — usually cart / order id.
    externalId: z.string().max(256).optional(),
    // The invoice-level `receive_address` (what the payer sees on the checkout
    // page). Matches across any token paid into that address for this merchant.
    // Canonicalized at the HTTP layer before calling — domain does exact match.
    toAddress: z.string().min(1).max(128).optional(),
    // Payer address filter. Requires a subquery against `transactions` because
    // invoices don't carry a payer column — an invoice matches when ANY of its
    // confirmed-or-detected transactions has this `from_address`. `reverted` /
    // `orphaned` transactions are excluded so a single stray payment doesn't
    // surface unrelated invoices.
    fromAddress: z.string().min(1).max(128).optional(),
    // Inclusive lower / upper bounds on `createdAt`. Either or both; both
    // omitted = unbounded. Unix ms epoch — the HTTP layer parses ISO strings.
    createdFrom: z.number().int().nonnegative().optional(),
    createdTo: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(LIST_INVOICES_MAX_LIMIT).default(25),
    offset: z.number().int().min(0).default(0)
  })
  .refine(
    (v) => v.createdFrom === undefined || v.createdTo === undefined || v.createdFrom <= v.createdTo,
    { message: "`createdFrom` must be <= `createdTo`" }
  );
export type ListInvoicesInput = z.infer<typeof ListInvoicesInputSchema>;

export interface ListInvoicesResult {
  invoices: readonly Invoice[];
  limit: number;
  offset: number;
  // True when another page exists. Computed via fetch-N+1 rather than
  // COUNT(*) — COUNT on a heavily-filtered table with 100k+ invoices adds a
  // second index scan per page, which we don't want on the hot list path.
  hasMore: boolean;
}

// Merchant-scoped invoice listing. Sort is fixed: createdAt DESC (newest
// first) — backed by `idx_invoices_merchant` on (merchantId, createdAt DESC).
// Caller is responsible for ensuring `merchantId` is the authenticated
// merchant's id (the HTTP layer injects it from the auth context).
export async function listInvoices(
  deps: AppDeps,
  input: unknown
): Promise<ListInvoicesResult> {
  const parsed = ListInvoicesInputSchema.parse(input);

  const conditions: SQL[] = [eq(invoices.merchantId, parsed.merchantId)];
  if (parsed.status && parsed.status.length > 0) {
    conditions.push(inArray(invoices.status, parsed.status));
  }
  if (parsed.chainId !== undefined) conditions.push(eq(invoices.chainId, parsed.chainId));
  if (parsed.token !== undefined) conditions.push(eq(invoices.token, parsed.token));
  if (parsed.externalId !== undefined) conditions.push(eq(invoices.externalId, parsed.externalId));
  if (parsed.toAddress !== undefined) conditions.push(eq(invoices.receiveAddress, parsed.toAddress));
  if (parsed.fromAddress !== undefined) {
    // `transactions` has no direct merchant column — the outer
    // `invoices.merchantId = X` filter scopes the result, so the subquery
    // can restrict purely on the payer address. Excludes reverted / orphaned
    // statuses so a failed or mis-attributed tx doesn't surface a stale
    // invoice on the merchant's list.
    conditions.push(
      inArray(
        invoices.id,
        deps.db
          .select({ id: transactions.invoiceId })
          .from(transactions)
          .where(
            and(
              eq(transactions.fromAddress, parsed.fromAddress),
              inArray(transactions.status, ["detected", "confirmed"]),
              isNotNull(transactions.invoiceId)
            )
          )
      )
    );
  }
  if (parsed.createdFrom !== undefined) conditions.push(gte(invoices.createdAt, parsed.createdFrom));
  if (parsed.createdTo !== undefined) conditions.push(lte(invoices.createdAt, parsed.createdTo));

  // fetch limit+1 to detect hasMore without a COUNT(*) round-trip. The extra
  // row (if any) is dropped before we hydrate addresses.
  const rows = await deps.db
    .select()
    .from(invoices)
    .where(and(...conditions))
    .orderBy(desc(invoices.createdAt))
    .limit(parsed.limit + 1)
    .offset(parsed.offset);

  const hasMore = rows.length > parsed.limit;
  const page = hasMore ? rows.slice(0, parsed.limit) : rows;

  // Hydrate receive-addresses. Batched into one SELECT with IN (ids) rather
  // than N per-invoice reads — important on a 100-row page where the
  // per-request hydration would otherwise be a 100-query fan-out.
  const hydrated = await hydrateInvoicesWithAddresses(deps, page);

  return { invoices: hydrated, limit: parsed.limit, offset: parsed.offset, hasMore };
}

async function hydrateInvoicesWithAddresses(
  deps: AppDeps,
  rows: readonly (typeof invoices.$inferSelect)[]
): Promise<Invoice[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const addrRows = await deps.db
    .select({
      invoiceId: invoiceReceiveAddresses.invoiceId,
      family: invoiceReceiveAddresses.family,
      chainId: invoiceReceiveAddresses.chainId,
      address: invoiceReceiveAddresses.address,
      poolAddressId: invoiceReceiveAddresses.poolAddressId
    })
    .from(invoiceReceiveAddresses)
    .where(inArray(invoiceReceiveAddresses.invoiceId, ids))
    .orderBy(asc(invoiceReceiveAddresses.family), asc(invoiceReceiveAddresses.chainId));
  const byInvoice = new Map<string, InvoiceReceiveAddress[]>();
  for (const r of addrRows) {
    const list = byInvoice.get(r.invoiceId) ?? [];
    list.push({
      family: r.family as ChainFamily,
      chainId: r.chainId,
      address: r.address as InvoiceReceiveAddress["address"],
      poolAddressId: r.poolAddressId
    });
    byInvoice.set(r.invoiceId, list);
  }
  return rows.map((row) => drizzleRowToInvoice(row, byInvoice.get(row.id) ?? []));
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
  // Expirable iff still in a non-terminal lifecycle stage. `pending` covers
  // invoices with no payment activity; `processing` covers invoices that
  // received some payment but never crossed the threshold (`extra_status`
  // is 'partial' on those, but the WHERE clause doesn't need to filter on
  // it — both pending and processing are eligible).
  const [row] = await deps.db
    .update(invoices)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(invoices.id, invoiceId), inArray(invoices.status, ["pending", "processing"])))
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

// Cron-driven expiration sweeper. Transitions every pending/processing row
// past its expiresAt to `expired`, then publishes invoice.expired per row so
// downstream subscribers (pool release, webhook dispatch) fire. Without this,
// expired invoices sit in their pre-expiry state forever — payment polling
// skips them (poll-payments.ts gates on expiresAt > now), but their pool
// addresses never return to rotation and the merchant never receives the
// lifecycle webhook.
export async function sweepExpiredInvoices(deps: AppDeps): Promise<SweepExpiredInvoicesResult> {
  const now = deps.clock.now().getTime();
  const updated = await deps.db
    .update(invoices)
    .set({ status: "expired", updatedAt: now })
    .where(and(inArray(invoices.status, ["pending", "processing"]), lte(invoices.expiresAt, now)))
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

// Decide WHICH chain adapter(s) — and which chainId(s) — to allocate
// receive addresses on for a single accepted family. Returns one entry per
// (adapter, chainId) the loop should mint an address for.
//
//   - PRIMARY family: exactly one entry, on the request's `parsed.chainId`.
//     Uses `primaryChainAdapter` directly so chainId-specific UTXO adapters
//     (BTC vs LTC vs testnets) are routed correctly even though all share
//     `family === "utxo"`.
//
//   - NON-PRIMARY EVM/Tron/Solana: one entry. Pick the first registered
//     adapter for that family; record its `supportedChainIds[0]` as the
//     chainId. EVM/Tron/Solana addresses are chain-agnostic across the
//     family, so the chainId is informational (frontends use it for label
//     rendering), not authoritative.
//
//   - NON-PRIMARY UTXO: ONE ENTRY PER REGISTERED UTXO CHAIN. BTC and LTC
//     (and any future DASH/DOGE) have structurally different addresses, so
//     a "I accept UTXO" universal invoice yields one row per chain the
//     deployment can serve. Customer picks their wallet's chain at payment
//     time. Sorted by chainId for deterministic order.
interface AllocationTarget {
  readonly adapter: ChainAdapter;
  readonly chainId: ChainId;
}
function resolveAllocationAdaptersForFamily(args: {
  family: ChainFamily;
  primaryFamily: ChainFamily;
  primaryChainAdapter: ChainAdapter;
  primaryChainId: ChainId;
  chains: readonly ChainAdapter[];
}): readonly AllocationTarget[] {
  if (args.family === args.primaryFamily) {
    return [{ adapter: args.primaryChainAdapter, chainId: args.primaryChainId }];
  }
  if (args.family === "utxo") {
    // Every registered UTXO adapter, sorted by its primary supported
    // chainId. De-duped on chainId so a deployment that wires the same
    // chain twice doesn't double-allocate.
    const seen = new Set<number>();
    const targets: AllocationTarget[] = [];
    for (const adapter of args.chains) {
      if (adapter.family !== "utxo") continue;
      for (const cid of adapter.supportedChainIds) {
        if (seen.has(cid)) continue;
        seen.add(cid);
        targets.push({ adapter, chainId: cid as ChainId });
      }
    }
    targets.sort((a, b) => a.chainId - b.chainId);
    return targets;
  }
  // EVM / Tron / Solana — single adapter handles all chainIds in the
  // family. Take the first match and record its first supported chainId
  // as the row's `chain_id` (informational).
  const adapter = args.chains.find((c) => c.family === args.family);
  if (adapter === undefined) return [];
  const firstChainId = adapter.supportedChainIds[0];
  if (firstChainId === undefined) return [];
  return [{ adapter, chainId: firstChainId as ChainId }];
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

// Authoritative chainId → family lookup via the chain registry. The previous
// hardcoded copy lived here AND in rate-window.ts, and the two drifted: the
// rate-window copy lacked the UTXO branch and routed BTC/LTC chainIds to
// "evm" via a `chainId > 0` catch-all, breaking USD-path invoices on UTXO
// chains. Both files now route through `chainEntry()` so a future chain
// addition needs to touch CHAIN_REGISTRY only.
function familyForChainId(chainId: number): ChainFamily | null {
  return chainEntry(chainId)?.family ?? null;
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
