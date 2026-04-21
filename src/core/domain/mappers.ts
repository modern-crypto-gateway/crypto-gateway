import { asc, eq } from "drizzle-orm";
import type { AppDeps } from "../app-deps.js";
import type { ChainFamily } from "../types/chain.js";
import type { Invoice, InvoiceId, InvoiceReceiveAddress, InvoiceStatus } from "../types/invoice.js";
import type { Payout, PayoutId, PayoutStatus } from "../types/payout.js";
import type { Transaction, TransactionId, TxStatus } from "../types/transaction.js";
import { invoices, invoiceReceiveAddresses, payouts, transactions } from "../../db/schema.js";

// DB row <-> domain object conversions. Kept in one place so invoice.service.ts
// and payment.service.ts don't drift on shape.

export function drizzleRowToInvoice(
  row: typeof invoices.$inferSelect,
  receiveAddresses: readonly InvoiceReceiveAddress[]
): Invoice {
  const acceptedFamilies = Array.from(new Set(receiveAddresses.map((r) => r.family)));
  return {
    id: row.id as InvoiceId,
    merchantId: row.merchantId as Invoice["merchantId"],
    status: row.status as InvoiceStatus,
    chainId: row.chainId,
    token: row.token,
    receiveAddress: row.receiveAddress,
    addressIndex: row.addressIndex,
    acceptedFamilies,
    receiveAddresses: [...receiveAddresses],
    requiredAmountRaw: row.requiredAmountRaw,
    receivedAmountRaw: row.receivedAmountRaw,
    fiatAmount: row.fiatAmount,
    fiatCurrency: row.fiatCurrency,
    quotedRate: row.quotedRate,
    amountUsd: row.amountUsd,
    paidUsd: row.paidUsd,
    overpaidUsd: row.overpaidUsd,
    rateWindowExpiresAt: row.rateWindowExpiresAt === null ? null : new Date(row.rateWindowExpiresAt),
    rates:
      row.ratesJson === null
        ? null
        : (JSON.parse(row.ratesJson) as Record<string, string>),
    externalId: row.externalId,
    metadata: row.metadataJson === null ? null : (JSON.parse(row.metadataJson) as Record<string, unknown>),
    webhookUrl: row.webhookUrl,
    paymentToleranceUnderBps: row.paymentToleranceUnderBps,
    paymentToleranceOverBps: row.paymentToleranceOverBps,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt),
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
    updatedAt: new Date(row.updatedAt)
  };
}

// Fetch an invoice's per-family receive addresses from the join table.
// Used by every invoice read path that needs a full Invoice object.
export async function fetchInvoiceReceiveAddresses(
  deps: AppDeps,
  invoiceId: string
): Promise<readonly InvoiceReceiveAddress[]> {
  const rows = await deps.db
    .select({
      family: invoiceReceiveAddresses.family,
      address: invoiceReceiveAddresses.address,
      poolAddressId: invoiceReceiveAddresses.poolAddressId
    })
    .from(invoiceReceiveAddresses)
    .where(eq(invoiceReceiveAddresses.invoiceId, invoiceId))
    .orderBy(asc(invoiceReceiveAddresses.family));
  return rows.map((r) => ({
    family: r.family as ChainFamily,
    address: r.address as InvoiceReceiveAddress["address"],
    poolAddressId: r.poolAddressId
  }));
}

// Loads and hydrates a full Invoice by id (row + join). Returns null if the
// invoice doesn't exist. Two queries — acceptable for single-invoice reads;
// high-volume loops (pollPayments) should batch the join separately.
export async function loadInvoice(deps: AppDeps, invoiceId: string): Promise<Invoice | null> {
  const [row] = await deps.db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!row) return null;
  const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceId);
  return drizzleRowToInvoice(row, addresses);
}

export function drizzleRowToTransaction(row: typeof transactions.$inferSelect): Transaction {
  return {
    id: row.id as TransactionId,
    invoiceId: row.invoiceId === null ? null : (row.invoiceId as InvoiceId),
    chainId: row.chainId,
    txHash: row.txHash,
    logIndex: row.logIndex,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    token: row.token,
    amountRaw: row.amountRaw,
    blockNumber: row.blockNumber,
    confirmations: row.confirmations,
    status: row.status as TxStatus,
    detectedAt: new Date(row.detectedAt),
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
    amountUsd: row.amountUsd,
    usdRate: row.usdRate
  };
}

export function drizzleRowToPayout(row: typeof payouts.$inferSelect): Payout {
  return {
    id: row.id as PayoutId,
    merchantId: row.merchantId as Payout["merchantId"],
    kind: row.kind,
    parentPayoutId: row.parentPayoutId === null ? null : (row.parentPayoutId as PayoutId),
    status: row.status as PayoutStatus,
    chainId: row.chainId,
    token: row.token,
    amountRaw: row.amountRaw,
    quotedAmountUsd: row.quotedAmountUsd,
    quotedRate: row.quotedRate,
    feeTier: (row.feeTier as "low" | "medium" | "high" | null) ?? null,
    feeQuotedNative: row.feeQuotedNative,
    batchId: row.batchId,
    destinationAddress: row.destinationAddress,
    sourceAddress: row.sourceAddress,
    txHash: row.txHash,
    topUpTxHash: row.topUpTxHash,
    topUpSponsorAddress: row.topUpSponsorAddress,
    topUpAmountRaw: row.topUpAmountRaw,
    feeEstimateNative: row.feeEstimateNative,
    lastError: row.lastError,
    webhookUrl: row.webhookUrl,
    createdAt: new Date(row.createdAt),
    submittedAt: row.submittedAt === null ? null : new Date(row.submittedAt),
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
    broadcastAttemptedAt:
      row.broadcastAttemptedAt === null ? null : new Date(row.broadcastAttemptedAt),
    updatedAt: new Date(row.updatedAt)
  };
}
