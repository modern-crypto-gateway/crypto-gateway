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
    // Default payment tolerance in basis points (1 bp = 0.01%). Applied when
    // an invoice doesn't carry its own override.
    //   under: paid_usd >= amount_usd * (1 - under/10_000) → confirmed
    //          (e.g. 100 bps = 1%; pay 99% → confirmed instead of partial)
    //   over:  paid_usd <= amount_usd * (1 + over /10_000) → confirmed
    //          (e.g. 100 bps = 1%; pay 101% → confirmed instead of overpaid)
    paymentToleranceUnderBps: integer("payment_tolerance_under_bps").notNull().default(0),
    paymentToleranceOverBps: integer("payment_tolerance_over_bps").notNull().default(0),
    // Seconds an address remains parked after release (invoice expired/canceled/
    // confirmed) before pool allocation may re-hand it to another invoice. Late
    // payments arriving during the cooldown still credit the original invoice
    // (orphan + admin-attribute path); after cooldown expires, late payments
    // become orphans available for reconciliation. 0 = no cooldown (legacy).
    addressCooldownSeconds: integer("address_cooldown_seconds").notNull().default(0),
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
      enum: ["pending", "processing", "completed", "expired", "canceled"]
    }).notNull(),
    // Payment-fidelity signal orthogonal to `status`. See
    // src/core/types/invoice.ts for the (status, extra_status) state grid.
    //   NULL       — normal flow, nothing special
    //   'partial'  — 0 < paid < threshold (paired with status='processing')
    //   'overpaid' — paid > threshold + tolerance (paired with status='completed')
    extraStatus: text("extra_status", { enum: ["partial", "overpaid"] }),

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

    // Per-invoice payment tolerance in basis points. Snapshotted from the
    // merchant defaults at create time (or from per-invoice override input);
    // a later change to the merchant default does not retroactively reshape
    // already-issued invoices. See merchants.payment_tolerance_*_bps for the
    // status-transition semantics.
    paymentToleranceUnderBps: integer("payment_tolerance_under_bps").notNull().default(0),
    paymentToleranceOverBps: integer("payment_tolerance_over_bps").notNull().default(0),

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
      sql`${t.status} IN ('pending','processing','completed','expired','canceled')`
    ),
    check(
      "invoices_extra_status_check",
      sql`${t.extraStatus} IS NULL OR ${t.extraStatus} IN ('partial','overpaid')`
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
    usdRate: text("usd_rate"),
    // Admin-side dismissal of an orphaned transfer (invoice_id IS NULL row that
    // an operator decided not to credit — e.g. confirmed customer error or
    // unrelated address reuse). Both columns set together; the partial-index on
    // open orphans excludes dismissed rows so the admin queue stays clean while
    // the underlying tx record stays in place for audit.
    dismissedAt: integer("dismissed_at"),
    dismissReason: text("dismiss_reason")
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
    // Open orphans (no invoice attribution, not yet dismissed). Powers the
    // admin orphan queue scoped by chain and ordered by detection time.
    index("idx_transactions_orphans_open")
      .on(t.chainId, t.detectedAt)
      .where(sql`${t.invoiceId} IS NULL AND ${t.dismissedAt} IS NULL`),
    check(
      "transactions_status_check",
      sql`${t.status} IN ('detected','confirmed','reverted','orphaned')`
    )
  ]
);

// ---- utxos (UTXO-family spendability overlay on top of `transactions`) ----
//
// `transactions` is the source of truth for on-chain facts: amount, status,
// confirmations, txHash, vout (carried in `logIndex`), invoice link, reorg
// state. For UTXO-family chains we also need to track which outputs are
// CURRENTLY SPENDABLE — i.e. confirmed and not yet consumed by an outgoing
// payout. This table is that overlay.
//
// Each row maps 1:1 to a `transactions` row that paid one of our addresses
// (FK enforces this). The row carries the UTXO-specific bookkeeping we need
// at coin-selection / sign time:
//
//   - `script_pubkey` — the scriptPubKey we'd be spending; used to compute
//     witness-v0 sighash without re-deriving from the address every time.
//   - `address_index` — BIP44 index for HD private-key derivation when
//     building the input's witness signature. Snapshotted from the invoice
//     row at ingest so payout signing doesn't need a join back to invoices.
//   - `value_sats` — raw output value (decimal string for libSQL — uint64
//     doesn't fit JS number). Coin selection orders by this.
//   - `spent_in_payout_id` — NULL until a payout consumes the UTXO; set in
//     the same DB tx as the broadcast attempt so a crash mid-flight either
//     never reserves the UTXO (clean retry) or marks it spent atomically.
//
// Confirmation state lives on `transactions.status` (NOT duplicated here):
// the spendable index pairs with `transactions.status='confirmed'` at query
// time. Reorg-recheck flips the parent tx to 'orphaned' → coinselect's
// JOIN naturally excludes the affected utxo. No separate orphan flag needed
// on this table.
//
// Non-UTXO-family chains (EVM, Tron, Solana) do NOT write to this table.
export const utxos = sqliteTable(
  "utxos",
  {
    // "{txHash}:{vout}" — globally unique outpoint identifier.
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id),
    chainId: integer("chain_id").notNull(),
    // Our owned address holding this output. Canonical (lowercase bech32).
    address: text("address").notNull(),
    // BIP44 index used to derive the private key. Snapshotted at ingest so
    // signing doesn't need a join to invoices to recover it.
    addressIndex: integer("address_index").notNull(),
    // Output index within the parent tx (== `transactions.log_index` for the
    // same row, denormalized for query convenience).
    vout: integer("vout").notNull(),
    valueSats: text("value_sats").notNull(),
    // Hex-encoded scriptPubKey (P2WPKH = OP_0 <20-byte hash160>).
    scriptPubkey: text("script_pubkey").notNull(),
    // FK to payouts.id when consumed. NULL = spendable.
    spentInPayoutId: text("spent_in_payout_id").references(() => payouts.id),
    spentAt: integer("spent_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    // One row per outpoint (chain_id is part of the key only because synthetic
    // chainIds across families are independent; (transaction_id) alone is
    // already unique because transactions.id is a UUID).
    uniqueIndex("uq_utxos_outpoint").on(t.chainId, t.transactionId),
    // Hot-path index for coin selection: scoped to a chain, partial on
    // unspent. The address column is included so the query planner can
    // fan addresses out for per-source coin selection without a heap lookup.
    index("idx_utxos_spendable")
      .on(t.chainId, t.spentInPayoutId, t.address)
      .where(sql`${t.spentInPayoutId} IS NULL`),
    // Reverse lookup for "show me all UTXOs that funded payout X" — used by
    // admin reconciliation views and the gas-burn debit path.
    index("idx_utxos_spent_in_payout")
      .on(t.spentInPayoutId)
      .where(sql`${t.spentInPayoutId} IS NOT NULL`)
  ]
);

// ---- payout_reservations (active debits against an HD source address) ----
//
// The ledger treats every HD-derived address we control (`address_pool`
// rows — pool, sweep-master, everything) as a payout source. Spendable
// balance is computed from confirmed inbound (`transactions`) minus
// confirmed outbound (`payouts`) minus active reservations on this table.
//
// One payout can hold multiple reservation rows:
//   - `role='source'` on address S for the token being sent (amount_raw =
//     payout amount).
//   - `role='source'` on address S for NATIVE when S also needs to fund its
//     own gas out of its native balance. Omitted when the payout is itself
//     native — that reservation already covers both legs.
//   - `role='top_up_sponsor'` on address T for NATIVE when S lacks gas and
//     another HD address T is tapped to just-in-time top up S.
//
// `released_at` is the soft-delete: rows stay forever as audit trail;
// the index on (chain_id, address, token) WHERE released_at IS NULL
// scopes the hot query.
export const payoutReservations = sqliteTable(
  "payout_reservations",
  {
    id: text("id").primaryKey(),
    payoutId: text("payout_id")
      .notNull()
      .references(() => payouts.id),
    role: text("role", { enum: ["source", "top_up_sponsor"] }).notNull(),
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    // Token symbol (e.g. "USDT", "USDC") or the sentinel "NATIVE" for the
    // chain's native asset. Matches how `transactions.token` is populated.
    token: text("token").notNull(),
    amountRaw: text("amount_raw").notNull(),
    createdAt: integer("created_at").notNull(),
    releasedAt: integer("released_at")
  },
  (t) => [
    index("idx_reservations_active")
      .on(t.chainId, t.address, t.token)
      .where(sql`${t.releasedAt} IS NULL`),
    index("idx_reservations_payout").on(t.payoutId),
    check("reservations_role_check", sql`${t.role} IN ('source','top_up_sponsor')`)
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
    // `standard` = merchant-facing payout row. `gas_top_up` = internal
    // sibling inserted when the source address lacked native for gas and
    // a second HD address had to top it up first. gas_top_up rows are
    // filtered out of merchant-facing lists but still debit the sponsor's
    // native balance through the normal `payouts.amountRaw` path, which
    // keeps `computeSpendable` single-sourced.
    //
    // `gas_burn` rows are synthetic debits created when a standard or
    // gas_top_up payout transitions to `failed` with a non-null txHash —
    // i.e. the tx reached chain and consumed gas/energy before reverting.
    // The chain charges even reverted txs (EVM: gasUsed × effectiveGasPrice,
    // Tron: net_fee + energy_fee, Solana: signature fee), and without this
    // synthetic debit the DB's computed spendable drifts higher than the
    // on-chain balance every time a payout fails. These rows carry:
    //   - kind='gas_burn'
    //   - token=<native>, amountRaw=<fee in native units>
    //   - sourceAddress=<address actually debited>
    //   - parentPayoutId=<failed payout id>
    //   - status='confirmed' (so the existing computeSpendable debit query
    //     picks them up without changes)
    //   - txHash=<failed payout's txHash>
    //   - feeTier=null, feeQuotedNative=null, topUp*=null
    // Merchant-facing list endpoints filter them out the same way they
    // filter gas_top_up.
    kind: text("kind", { enum: ["standard", "gas_top_up", "gas_burn"] }).notNull().default("standard"),
    // Set on `gas_top_up` rows, pointing at the standard payout that
    // triggered the top-up. NULL on standard rows.
    parentPayoutId: text("parent_payout_id"),
    status: text("status", {
      enum: [
        "planned",
        "reserved",
        "topping-up",
        "submitted",
        "confirmed",
        "failed",
        "canceled"
      ]
    }).notNull(),

    chainId: integer("chain_id").notNull(),
    token: text("token").notNull(),
    amountRaw: text("amount_raw").notNull(),
    // USD-pegged audit trail. Populated only when the create request used
    // `amountUSD`; both NULL for `amountRaw` / `amount` paths. Stored so the
    // operator can later answer "what rate did we apply for this payout?"
    // without having to replay the price oracle.
    quotedAmountUsd: text("quoted_amount_usd"),
    quotedRate: text("quoted_rate"),
    // Fee tier bound on the broadcast tx ("low" | "medium" | "high"). Defaults
    // to "medium" when unset. Adapters that don't support tiers (Tron) ignore.
    feeTier: text("fee_tier"),
    // Native-units fee at quote time, captured from the chosen tier's
    // `nativeAmountRaw`. Lets operators compare quoted vs. on-chain actual
    // after broadcast.
    feeQuotedNative: text("fee_quoted_native"),
    // Optional grouping id for mass-payout batches. NULL for single-payout
    // creates; set to the same value across every row of a `POST /payouts/batch`
    // request. Used as a list filter so operators can pull "all payouts in
    // batch X" in one query.
    batchId: text("batch_id"),
    destinationAddress: text("destination_address").notNull(),
    // NULL until planned → reserved picks a source from the HD pool.
    sourceAddress: text("source_address"),
    // NULL until reserved → submitted broadcasts.
    txHash: text("tx_hash"),
    feeEstimateNative: text("fee_estimate_native"),
    // When the source lacked native for gas, the executor first broadcasts
    // a top-up from a sponsor address. These columns hold the audit trail
    // for that top-up on the parent (standard) row. NULL when no top-up
    // was needed. See `parentPayoutId` for the sibling gas_top_up row that
    // owns the actual ledger debit on the sponsor.
    //
    // `topUpAmountRaw` is set at PLAN time when the picker decides a top-up
    // is required: it's the native amount the sponsor will move to the
    // source (gap + cushion). The sponsor reservation row carries this
    // PLUS the sponsor's own broadcast gas; we keep the transfer amount
    // here separately so the executor doesn't have to reverse-derive it.
    topUpTxHash: text("top_up_tx_hash"),
    topUpSponsorAddress: text("top_up_sponsor_address"),
    topUpAmountRaw: text("top_up_amount_raw"),
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
    // Partial index on batch_id: most rows have batch_id=NULL (only set by
    // POST /payouts/batch), so a partial index keeps storage minimal while
    // making ?batchId=<uuid> list filters O(log n) instead of full-scan.
    index("idx_payouts_batch_id").on(t.batchId).where(sql`${t.batchId} IS NOT NULL`),
    // Pulls every child gas_top_up for a parent in one scan — used by the
    // executor to re-hydrate the top-up state machine and by the admin
    // audit view.
    index("idx_payouts_parent").on(t.parentPayoutId).where(sql`${t.parentPayoutId} IS NOT NULL`),
    check(
      "payouts_status_check",
      sql`${t.status} IN ('planned','reserved','topping-up','submitted','confirmed','failed','canceled')`
    ),
    check(
      "payouts_kind_check",
      sql`${t.kind} IN ('standard','gas_top_up','gas_burn')`
    ),
    check(
      "payouts_fee_tier_check",
      sql`${t.feeTier} IS NULL OR ${t.feeTier} IN ('low','medium','high')`
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
    family: text("family", { enum: ["evm", "tron", "solana", "utxo"] }).notNull(),
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
    // Set when the row last transitioned allocated → available. Allocation
    // tie-breaks MIN(totalAllocations) by ASC NULLS FIRST on this column so
    // never-used rows win, then the longest-dormant rows, with a just-released
    // row going to the back of the queue. Goal: a late payment to a recently
    // expired invoice still lands on the address that was tied to that
    // invoice rather than on a freshly-reused one.
    lastReleasedAt: integer("last_released_at"),
    // Cooldown deadline (epoch ms). When set and > now, allocation must skip
    // this row even if it would otherwise win the fairness ordering. Computed
    // at release time as `now + merchant.address_cooldown_seconds * 1000`. NULL
    // (or past) means immediately reusable. Stored on the row to avoid a JOIN
    // against merchants in the hot allocator path.
    cooldownUntil: integer("cooldown_until"),
    // Merchant whose invoice last released this row. Carried alongside
    // `cooldownUntil` so admin reconciliation knows which merchant a late
    // payment likely belongs to during the cooldown window. Cleared on next
    // allocation.
    lastReleasedByMerchantId: text("last_released_by_merchant_id"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("uq_address_pool_family_index").on(t.family, t.addressIndex),
    uniqueIndex("uq_address_pool_family_address").on(t.family, t.address),
    // Allocation candidate index. Pairs with the cooldown filter in the
    // allocator (`cooldown_until IS NULL OR cooldown_until <= now`); we don't
    // index `cooldownUntil` itself because its selectivity is low and the
    // status='available' prefix already narrows aggressively.
    index("idx_address_pool_available").on(
      t.family,
      t.status,
      t.totalAllocations,
      t.lastReleasedAt,
      t.addressIndex
    ),
    index("idx_address_pool_allocated").on(t.allocatedToInvoiceId),
    check("address_pool_family_check", sql`${t.family} IN ('evm','tron','solana','utxo')`),
    check(
      "address_pool_status_check",
      sql`${t.status} IN ('available','allocated','quarantined')`
    )
  ]
);

// ---- fee_wallets (optional per-family gas provider) ----
//
// Zero or one row per family. When a row exists, the payout planner prefers
// the fee-wallet path for that family over the source-pays-own-gas path:
//   - Solana: fee wallet co-signs every payout as the tx's feePayer. Pool
//             address never spends SOL. ATA-creation rent and signature fee
//             both come from the fee wallet.
//   - Tron:   fee wallet stakes TRX and delegates energy/bandwidth to pool
//             addresses via DelegateResource. Pool address's tx consumes
//             delegated resources without burning TRX. Setup is one-time
//             per pool address via the admin delegation endpoints.
//   - EVM:    not supported (EIP-1559 has no feePayer separation); the
//             existing sponsor-topup pattern remains the gas strategy.
//
// Two modes:
//   - mode='hd-pool'   : `address` refers to an existing address_pool row
//                         in the same family; private key is derived from
//                         MASTER_SEED on demand (same path as pool payouts
//                         already take). No new secret material.
//   - mode='imported' : `address` is an externally-generated wallet the
//                         operator brought; private key is encrypted at rest
//                         via secretsCipher (AES-256-GCM). Lets operators
//                         bring a pre-staked Tron wallet whose stake history
//                         they don't want to reset.
export const feeWallets = sqliteTable(
  "fee_wallets",
  {
    id: text("id").primaryKey(),
    family: text("family", { enum: ["evm", "tron", "solana", "utxo"] }).notNull(),
    mode: text("mode", { enum: ["hd-pool", "imported"] }).notNull(),
    // Canonical address form — matches the corresponding chain adapter's
    // canonicalizeAddress output. For hd-pool mode this MUST equal an
    // address_pool.address in the same family (FK enforced application-side
    // since libSQL doesn't enforce FKs per-connection).
    address: text("address").notNull(),
    // Present ONLY for mode='imported'. Self-describing ciphertext from
    // secretsCipher (`v1:<base64>` format — nonce + auth tag bundled inside
    // the encoded payload, which is why there's no separate nonce column).
    // Null for hd-pool mode since that path derives on demand.
    privateKeyCiphertext: text("private_key_ciphertext"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    // At most one fee wallet per family. Operator swaps by DELETE + re-POST.
    uniqueIndex("uq_fee_wallets_family").on(t.family),
    check("fee_wallets_family_check", sql`${t.family} IN ('evm','tron','solana','utxo')`),
    check("fee_wallets_mode_check", sql`${t.mode} IN ('hd-pool','imported')`),
    // mode='imported' REQUIRES ciphertext; mode='hd-pool' must not carry one.
    // Enforced in SQL so a malformed manual edit can't slip through and
    // cause a decrypt-time NPE or a confused hd-pool wallet with stale key
    // material still hanging around.
    check(
      "fee_wallets_imported_shape",
      sql`(${t.mode} = 'hd-pool' AND ${t.privateKeyCiphertext} IS NULL)
         OR (${t.mode} = 'imported' AND ${t.privateKeyCiphertext} IS NOT NULL)`
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
    family: text("family", { enum: ["evm", "tron", "solana", "utxo"] }).notNull(),
    address: text("address").notNull(),
    // Pool-allocated address: NOT NULL on EVM / Tron / Solana invoices (every
    // receive address comes from `address_pool`). NULL on UTXO invoices —
    // those use fresh-per-invoice derivation via `address_index_counters` and
    // never participate in the pool's cooldown/reuse semantics. Privacy
    // heuristics on UTXO chains require non-reuse, so a pool row would be
    // structurally wrong here.
    poolAddressId: text("pool_address_id").references(() => addressPool.id),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    primaryKey({ columns: [t.invoiceId, t.family] }),
    index("idx_invoice_rx_address").on(t.address),
    index("idx_invoice_rx_pool").on(t.poolAddressId),
    check("invoice_rx_family_check", sql`${t.family} IN ('evm','tron','solana','utxo')`)
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
  utxos,
  payoutReservations,
  payouts,
  alchemyWebhookRegistry,
  alchemyAddressSubscriptions,
  addressPool,
  invoiceReceiveAddresses,
  webhookDeliveries
};
