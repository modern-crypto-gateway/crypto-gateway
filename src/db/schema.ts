import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

// Drizzle schema for crypto-gateway (Turso / libSQL, SQLite dialect).
//
// Conventions:
//   - TS field names are camelCase; underlying SQL columns stay snake_case for
//     continuity with the hand-written migrations we collapsed into the initial
//     drizzle-kit baseline.
//   - All amounts are TEXT (decimal strings). uint256 on EVM and native-sun
//     counts on Tron exceed JS number precision and bigint serializes
//     inconsistently across libSQL's HTTP driver; the domain layer parses /
//     formats at its own boundaries.
//   - All timestamps are INTEGER (epoch milliseconds) for wire portability.
//   - Enum columns use `text("...", { enum: [...] })` which emits both the
//     CHECK constraint and a narrow TS union.
//   - Booleans stored as INTEGER (1/0) — every row shape in the app already
//     treats `active` etc. numerically, so we keep the number type rather
//     than flip to Drizzle's `{ mode: "boolean" }` and force a migration of
//     every call site.
//
// FK enforcement: D1 enabled PRAGMA foreign_keys by default; libSQL does not
// (per-connection). We now standardize on libSQL, so referential integrity
// is enforced application-side in domain services that perform inserts
// against FK-constrained tables (invoices / payouts / transactions /
// webhook_deliveries all check `merchant` existence before insert).

// ---- merchants ----

export const merchants = sqliteTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    apiKeyHash: text("api_key_hash").notNull().unique(),
    webhookUrl: text("webhook_url"),
    webhookSecretCiphertext: text("webhook_secret_ciphertext"),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("idx_merchants_api_key_hash").on(t.apiKeyHash)]
);

// ---- invoices (was 'orders' pre-0004) ----

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    status: text("status", {
      enum: ["created", "partial", "detected", "confirmed", "overpaid", "expired", "canceled"]
    }).notNull(),

    chainId: integer("chain_id").notNull(),
    token: text("token").notNull(),
    receiveAddress: text("receive_address").notNull(),
    addressIndex: integer("address_index").notNull(),

    requiredAmountRaw: text("required_amount_raw").notNull(),
    receivedAmountRaw: text("received_amount_raw").notNull().default("0"),

    fiatAmount: text("fiat_amount"),
    fiatCurrency: text("fiat_currency"),
    quotedRate: text("quoted_rate"),

    externalId: text("external_id"),
    metadataJson: text("metadata_json"),

    // JSON array of family strings: `["evm","tron","solana"]`. NULL = legacy single-chain.
    acceptedFamilies: text("accepted_families"),

    // USD-path fields. amountUsd NULL = legacy token-amount path.
    amountUsd: text("amount_usd"),
    paidUsd: text("paid_usd").notNull().default("0"),
    overpaidUsd: text("overpaid_usd").notNull().default("0"),
    rateWindowExpiresAt: integer("rate_window_expires_at"),
    ratesJson: text("rates_json"),

    // Per-invoice webhook override. Both NULL → fall back to merchant's
    // webhook_url / webhook_secret_ciphertext. URL+secret are write-once at
    // create time and treated as a pair (one without the other is a footgun:
    // an HMAC needs both halves, mismatching them would silently sign the
    // wrong endpoint).
    webhookUrl: text("webhook_url"),
    webhookSecretCiphertext: text("webhook_secret_ciphertext"),

    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    confirmedAt: integer("confirmed_at"),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("idx_invoices_merchant").on(t.merchantId, sql`${t.createdAt} DESC`),
    index("idx_invoices_status").on(t.status, t.expiresAt),
    index("idx_invoices_receive_address").on(t.chainId, t.receiveAddress),
    // Partial unique index — same merchant can't reuse an external_id, but
    // NULL external_ids are allowed to repeat.
    uniqueIndex("uq_invoices_external_id")
      .on(t.merchantId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    check(
      "invoices_status_check",
      sql`${t.status} IN ('created','partial','detected','confirmed','overpaid','expired','canceled')`
    )
  ]
);

// ---- address_index_counters (per-chain monotonic derivation index) ----

export const addressIndexCounters = sqliteTable("address_index_counters", {
  chainId: integer("chain_id").primaryKey(),
  nextIndex: integer("next_index").notNull().default(0),
  updatedAt: integer("updated_at").notNull()
});

// ---- transactions (detected on-chain transfers, tied to an invoice when matched) ----

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    // NULL until matched to an invoice (orphan transfers stay recorded for reconciliation).
    invoiceId: text("invoice_id").references(() => invoices.id),
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    // NULL for native-asset transfers.
    logIndex: integer("log_index"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    token: text("token").notNull(),
    amountRaw: text("amount_raw").notNull(),
    blockNumber: integer("block_number"),
    confirmations: integer("confirmations").notNull().default(0),
    status: text("status", {
      enum: ["detected", "confirmed", "reverted", "orphaned"]
    }).notNull(),
    detectedAt: integer("detected_at").notNull(),
    confirmedAt: integer("confirmed_at"),
    amountUsd: text("amount_usd"),
    usdRate: text("usd_rate")
  },
  (t) => [
    // Two partial unique indexes together cover the same identity rule as the
    // original `UNIQUE(chain_id, tx_hash, COALESCE(log_index, -1))`: log-bearing
    // transfers dedupe on the triple, native transfers (log_index IS NULL)
    // dedupe on the pair. Drizzle-kit can't round-trip COALESCE inside an
    // index column list, so we spell it out as two indexes.
    uniqueIndex("uq_transactions_identity")
      .on(t.chainId, t.txHash, t.logIndex)
      .where(sql`${t.logIndex} IS NOT NULL`),
    uniqueIndex("uq_transactions_identity_native")
      .on(t.chainId, t.txHash)
      .where(sql`${t.logIndex} IS NULL`),
    index("idx_transactions_invoice").on(t.invoiceId),
    index("idx_transactions_status").on(t.status, t.chainId),
    check(
      "transactions_status_check",
      sql`${t.status} IN ('detected','confirmed','reverted','orphaned')`
    )
  ]
);

// ---- fee_wallets (gateway-owned outbound payout sources) ----

export const feeWallets = sqliteTable(
  "fee_wallets",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    label: text("label").notNull(),
    active: integer("active").notNull().default(1),
    // CAS reservation: set to the payout id while a single in-flight payout
    // holds the wallet; released on status transition.
    reservedByPayoutId: text("reserved_by_payout_id"),
    reservedAt: integer("reserved_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("uq_fee_wallets_chain_address").on(t.chainId, t.address),
    index("idx_fee_wallets_available").on(t.chainId, t.active, t.reservedByPayoutId)
  ]
);

// ---- payouts (outbound merchant payouts) ----

export const payouts = sqliteTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    status: text("status", {
      enum: ["planned", "reserved", "submitted", "confirmed", "failed", "canceled"]
    }).notNull(),

    chainId: integer("chain_id").notNull(),
    token: text("token").notNull(),
    amountRaw: text("amount_raw").notNull(),
    destinationAddress: text("destination_address").notNull(),
    // NULL until planned → reserved picks a fee wallet.
    sourceAddress: text("source_address"),
    // NULL until reserved → submitted broadcasts.
    txHash: text("tx_hash"),
    feeEstimateNative: text("fee_estimate_native"),
    lastError: text("last_error"),

    createdAt: integer("created_at").notNull(),
    submittedAt: integer("submitted_at"),
    confirmedAt: integer("confirmed_at"),
    updatedAt: integer("updated_at").notNull(),

    // Broadcast-idempotency slot. Claimed CAS before the chain-adapter call so
    // a crash after broadcast (but before the `submitted` write) can't retry
    // into a second on-chain tx.
    broadcastAttemptedAt: integer("broadcast_attempted_at"),

    // Per-payout webhook override. Same semantics as invoices.webhook_url:
    // write-once, URL+secret paired, fall back to merchant default when NULL.
    webhookUrl: text("webhook_url"),
    webhookSecretCiphertext: text("webhook_secret_ciphertext")
  },
  (t) => [
    index("idx_payouts_merchant").on(t.merchantId, sql`${t.createdAt} DESC`),
    index("idx_payouts_status").on(t.status, t.chainId),
    check(
      "payouts_status_check",
      sql`${t.status} IN ('planned','reserved','submitted','confirmed','failed','canceled')`
    )
  ]
);

// ---- alchemy_webhook_registry (per-chain HMAC keys) ----

export const alchemyWebhookRegistry = sqliteTable("alchemy_webhook_registry", {
  chainId: integer("chain_id").primaryKey(),
  // Alchemy's own id, e.g. wh_abc123.
  webhookId: text("webhook_id").notNull().unique(),
  // AES-GCM ciphertext per `v1:<base64>` — SecretsCipher.encrypt output.
  signingKeyCiphertext: text("signing_key_ciphertext").notNull(),
  webhookUrl: text("webhook_url").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

// ---- alchemy_address_subscriptions (queued add/remove ops) ----

export const alchemyAddressSubscriptions = sqliteTable(
  "alchemy_address_subscriptions",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    action: text("action", { enum: ["add", "remove"] }).notNull(),
    status: text("status", { enum: ["pending", "synced", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: integer("last_attempt_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("idx_alchemy_subs_pending").on(t.status, t.chainId, t.lastAttemptAt),
    check("alchemy_subs_action_check", sql`${t.action} IN ('add','remove')`),
    check("alchemy_subs_status_check", sql`${t.status} IN ('pending','synced','failed')`)
  ]
);

// ---- address_pool (reusable HD-derived receive addresses, per family) ----

export const addressPool = sqliteTable(
  "address_pool",
  {
    id: text("id").primaryKey(),
    family: text("family", { enum: ["evm", "tron", "solana"] }).notNull(),
    addressIndex: integer("address_index").notNull(),
    // Canonical form — hex for EVM, base58 for Tron/Solana.
    address: text("address").notNull(),
    status: text("status", {
      enum: ["available", "allocated", "quarantined"]
    }).notNull(),
    allocatedToInvoiceId: text("allocated_to_invoice_id"),
    allocatedAt: integer("allocated_at"),
    // Lifetime reuse counter. Allocation picks MIN(totalAllocations) first so
    // the same address doesn't get re-handed-out disproportionately.
    totalAllocations: integer("total_allocations").notNull().default(0),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("uq_address_pool_family_index").on(t.family, t.addressIndex),
    uniqueIndex("uq_address_pool_family_address").on(t.family, t.address),
    index("idx_address_pool_available").on(t.family, t.status, t.totalAllocations, t.addressIndex),
    index("idx_address_pool_allocated").on(t.allocatedToInvoiceId),
    check("address_pool_family_check", sql`${t.family} IN ('evm','tron','solana')`),
    check(
      "address_pool_status_check",
      sql`${t.status} IN ('available','allocated','quarantined')`
    )
  ]
);

// ---- invoice_receive_addresses (per-family address mapping for multi-family invoices) ----

export const invoiceReceiveAddresses = sqliteTable(
  "invoice_receive_addresses",
  {
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    family: text("family", { enum: ["evm", "tron", "solana"] }).notNull(),
    address: text("address").notNull(),
    poolAddressId: text("pool_address_id")
      .notNull()
      .references(() => addressPool.id),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    primaryKey({ columns: [t.invoiceId, t.family] }),
    index("idx_invoice_rx_address").on(t.address),
    index("idx_invoice_rx_pool").on(t.poolAddressId),
    check("invoice_rx_family_check", sql`${t.family} IN ('evm','tron','solana')`)
  ]
);

// ---- webhook_deliveries (outbox + dead-letter queue for merchant webhooks) ----

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    eventType: text("event_type").notNull(),
    // Stable key of the shape "<event>:<entity-id>:<status>" — deduplicates at
    // insert time when the same domain event fires twice (bus replay, poll
    // re-detection). UNIQUE constraint makes the subscriber's on-conflict
    // handling trivial.
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payloadJson: text("payload_json").notNull(),
    targetUrl: text("target_url").notNull(),
    // Resource the event belongs to. Used at retry time to re-resolve
    // the dispatch target (per-resource webhook → merchant fallback). NULL on
    // legacy rows from before per-resource webhooks shipped — those fall back
    // to merchant lookup directly.
    resourceType: text("resource_type", { enum: ["invoice", "payout"] }),
    resourceId: text("resource_id"),
    status: text("status", { enum: ["pending", "delivered", "dead"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("idx_webhook_deliveries_status_next").on(t.status, t.nextAttemptAt),
    index("idx_webhook_deliveries_merchant").on(t.merchantId, sql`${t.createdAt} DESC`),
    check(
      "webhook_deliveries_status_check",
      sql`${t.status} IN ('pending','delivered','dead')`
    )
  ]
);

// Aggregate re-export — lets call sites do `import * as schema from "../db/schema"`
// once and pass it to drizzle() / helpers.
export const schema = {
  merchants,
  invoices,
  addressIndexCounters,
  transactions,
  feeWallets,
  payouts,
  alchemyWebhookRegistry,
  alchemyAddressSubscriptions,
  addressPool,
  invoiceReceiveAddresses,
  webhookDeliveries
};
