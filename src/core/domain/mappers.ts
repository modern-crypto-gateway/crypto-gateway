import type { AppDeps } from "../app-deps.js";
import type { ChainFamily } from "../types/chain.js";
import type { Invoice, InvoiceId, InvoiceReceiveAddress, InvoiceStatus } from "../types/invoice.js";
import type { Payout, PayoutId, PayoutStatus } from "../types/payout.js";
import type { Transaction, TransactionId, TxStatus } from "../types/transaction.js";

// DB row <-> domain object conversions. Kept in one place so invoice.service.ts
// and payment.service.ts don't drift on shape.

export interface InvoiceRow {
  id: string;
  merchant_id: string;
  status: string;
  chain_id: number;
  token: string;
  receive_address: string;
  address_index: number;
  required_amount_raw: string;
  received_amount_raw: string;
  fiat_amount: string | null;
  fiat_currency: string | null;
  quoted_rate: string | null;
  external_id: string | null;
  metadata_json: string | null;
  // Multi-family accepted set. JSON-encoded ChainFamily[]; null for legacy
  // single-family invoices written pre-migration 0002.
  accepted_families: string | null;
  // USD-path columns.
  amount_usd: string | null;
  paid_usd: string;
  overpaid_usd: string;
  rate_window_expires_at: number | null;
  rates_json: string | null;
  created_at: number;
  expires_at: number;
  confirmed_at: number | null;
  updated_at: number;
}

// rowToInvoice requires the invoice's receive addresses (from the join table)
// because multi-family invoices have more than one and the Invoice type
// encodes that cleanly. Callers that already have the addresses in hand
// (createInvoice path) pass them; callers reading an existing invoice use
// `loadInvoice` below to bundle both queries.
export function rowToInvoice(row: InvoiceRow, receiveAddresses: readonly InvoiceReceiveAddress[]): Invoice {
  const acceptedFamilies = Array.from(new Set(receiveAddresses.map((r) => r.family)));
  return {
    id: row.id as InvoiceId,
    merchantId: row.merchant_id as Invoice["merchantId"],
    status: row.status as InvoiceStatus,
    chainId: row.chain_id,
    token: row.token,
    receiveAddress: row.receive_address,
    addressIndex: row.address_index,
    acceptedFamilies,
    receiveAddresses: [...receiveAddresses],
    requiredAmountRaw: row.required_amount_raw,
    receivedAmountRaw: row.received_amount_raw,
    fiatAmount: row.fiat_amount,
    fiatCurrency: row.fiat_currency,
    quotedRate: row.quoted_rate,
    amountUsd: row.amount_usd,
    paidUsd: row.paid_usd,
    overpaidUsd: row.overpaid_usd,
    rateWindowExpiresAt: row.rate_window_expires_at === null ? null : new Date(row.rate_window_expires_at),
    rates:
      row.rates_json === null
        ? null
        : (JSON.parse(row.rates_json) as Record<string, string>),
    externalId: row.external_id,
    metadata: row.metadata_json === null ? null : (JSON.parse(row.metadata_json) as Record<string, unknown>),
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at),
    updatedAt: new Date(row.updated_at)
  };
}

// Fetch an invoice's per-family receive addresses from the join table.
// Used by every invoice read path that needs a full Invoice object.
export async function fetchInvoiceReceiveAddresses(
  deps: AppDeps,
  invoiceId: string
): Promise<readonly InvoiceReceiveAddress[]> {
  const rows = await deps.db
    .prepare(
      `SELECT family, address, pool_address_id FROM invoice_receive_addresses
       WHERE invoice_id = ?
       ORDER BY family ASC`
    )
    .bind(invoiceId)
    .all<{ family: ChainFamily; address: string; pool_address_id: string }>();
  return rows.results.map((r) => ({
    family: r.family,
    address: r.address as InvoiceReceiveAddress["address"],
    poolAddressId: r.pool_address_id
  }));
}

// Loads and hydrates a full Invoice by id (row + join). Returns null if the
// invoice doesn't exist. Two queries — acceptable for single-invoice reads;
// high-volume loops (pollPayments) should batch the join separately.
export async function loadInvoice(deps: AppDeps, invoiceId: string): Promise<Invoice | null> {
  const row = await deps.db.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first<InvoiceRow>();
  if (!row) return null;
  const addresses = await fetchInvoiceReceiveAddresses(deps, invoiceId);
  return rowToInvoice(row, addresses);
}

export interface TxRow {
  id: string;
  invoice_id: string | null;
  chain_id: number;
  tx_hash: string;
  log_index: number | null;
  from_address: string;
  to_address: string;
  token: string;
  amount_raw: string;
  block_number: number | null;
  confirmations: number;
  status: string;
  detected_at: number;
  confirmed_at: number | null;
}

export function rowToTransaction(row: TxRow): Transaction {
  return {
    id: row.id as TransactionId,
    invoiceId: row.invoice_id === null ? null : (row.invoice_id as InvoiceId),
    chainId: row.chain_id,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    token: row.token,
    amountRaw: row.amount_raw,
    blockNumber: row.block_number,
    confirmations: row.confirmations,
    status: row.status as TxStatus,
    detectedAt: new Date(row.detected_at),
    confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at)
  };
}

export interface PayoutRow {
  id: string;
  merchant_id: string;
  status: string;
  chain_id: number;
  token: string;
  amount_raw: string;
  destination_address: string;
  source_address: string | null;
  tx_hash: string | null;
  fee_estimate_native: string | null;
  last_error: string | null;
  created_at: number;
  submitted_at: number | null;
  confirmed_at: number | null;
  updated_at: number;
}

export function rowToPayout(row: PayoutRow): Payout {
  return {
    id: row.id as PayoutId,
    merchantId: row.merchant_id as Payout["merchantId"],
    status: row.status as PayoutStatus,
    chainId: row.chain_id,
    token: row.token,
    amountRaw: row.amount_raw,
    destinationAddress: row.destination_address,
    sourceAddress: row.source_address,
    txHash: row.tx_hash,
    feeEstimateNative: row.fee_estimate_native,
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    submittedAt: row.submitted_at === null ? null : new Date(row.submitted_at),
    confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at),
    updatedAt: new Date(row.updated_at)
  };
}
