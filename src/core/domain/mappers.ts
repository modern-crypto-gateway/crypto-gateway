import type { Order, OrderId, OrderStatus } from "../types/order.js";
import type { Payout, PayoutId, PayoutStatus } from "../types/payout.js";
import type { Transaction, TransactionId, TxStatus } from "../types/transaction.js";

// DB row <-> domain object conversions. Kept in one place so order.service.ts
// and payment.service.ts don't drift on shape.

export interface OrderRow {
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
  created_at: number;
  expires_at: number;
  confirmed_at: number | null;
  updated_at: number;
}

export function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id as OrderId,
    merchantId: row.merchant_id as Order["merchantId"],
    status: row.status as OrderStatus,
    chainId: row.chain_id,
    token: row.token,
    receiveAddress: row.receive_address,
    addressIndex: row.address_index,
    requiredAmountRaw: row.required_amount_raw,
    receivedAmountRaw: row.received_amount_raw,
    fiatAmount: row.fiat_amount,
    fiatCurrency: row.fiat_currency,
    quotedRate: row.quoted_rate,
    externalId: row.external_id,
    metadata: row.metadata_json === null ? null : (JSON.parse(row.metadata_json) as Record<string, unknown>),
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at),
    updatedAt: new Date(row.updated_at)
  };
}

export interface TxRow {
  id: string;
  order_id: string | null;
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
    orderId: row.order_id === null ? null : (row.order_id as OrderId),
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
