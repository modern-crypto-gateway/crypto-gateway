-- Canonical schema for crypto-gateway v2.
-- Dialect: SQLite (D1 + libSQL). CI will generate schema-pg.sql from this as Phase 8 lands.
-- All amounts are TEXT (decimal strings) to avoid bigint serialization issues across adapters.
-- All timestamps are INTEGER (epoch milliseconds) for portability.
--
-- FOREIGN KEY enforcement: D1 enables `PRAGMA foreign_keys = ON` by default.
-- libSQL does NOT — the pragma is per-connection, not persisted. Running it
-- here only affects the connection that applies this schema. Production libSQL
-- deployments get referential integrity via application-level checks in
-- order.service / payout.service (both verify the merchant exists before insert).

CREATE TABLE IF NOT EXISTS merchants (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  api_key_hash        TEXT NOT NULL UNIQUE,
  webhook_url         TEXT,
  webhook_secret_ciphertext TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchants_api_key_hash ON merchants(api_key_hash);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  status                TEXT NOT NULL CHECK (status IN ('created','partial','detected','confirmed','expired','canceled')),

  chain_id              INTEGER NOT NULL,
  token                 TEXT NOT NULL,
  receive_address       TEXT NOT NULL,
  address_index         INTEGER NOT NULL,

  required_amount_raw   TEXT NOT NULL,
  received_amount_raw   TEXT NOT NULL DEFAULT '0',

  fiat_amount           TEXT,
  fiat_currency         TEXT,
  quoted_rate           TEXT,

  external_id           TEXT,
  metadata_json         TEXT,

  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  confirmed_at          INTEGER,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_receive_address ON orders(chain_id, receive_address);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_external_id ON orders(merchant_id, external_id) WHERE external_id IS NOT NULL;

-- Monotonic per-chain counter used to allocate the next HD derivation index.
-- A single-row table per chain_id lets us do an atomic `UPDATE ... RETURNING next_index`.
CREATE TABLE IF NOT EXISTS address_index_counters (
  chain_id      INTEGER PRIMARY KEY,
  next_index    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  -- Null until we match the tx to an order (orphan transfers to unknown addresses
  -- stay recorded for later reconciliation).
  order_id         TEXT REFERENCES orders(id),
  chain_id         INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  -- Null for native-asset transfers (the tx itself is the transfer event).
  -- Non-null for token/log-based transfers where a single tx may emit multiple.
  log_index        INTEGER,
  from_address     TEXT NOT NULL,
  to_address       TEXT NOT NULL,
  token            TEXT NOT NULL,
  amount_raw       TEXT NOT NULL,
  block_number     INTEGER,
  confirmations    INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('detected','confirmed','reverted','orphaned')),
  detected_at      INTEGER NOT NULL,
  confirmed_at     INTEGER
);

-- Identity: (chain_id, tx_hash, log_index) with NULL folded to -1 so duplicate
-- native transfers (same tx_hash, both log_index=NULL) are rejected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_identity
  ON transactions(chain_id, tx_hash, COALESCE(log_index, -1));
CREATE INDEX IF NOT EXISTS idx_transactions_order ON transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status, chain_id);

-- Gateway-owned fee / source wallets that fund outgoing payouts. Private keys
-- live in the SignerStore (encrypted at rest); this table tracks only public
-- state + reservation. One wallet can be used by at most one in-flight payout
-- at a time (CAS via `reserved_by_payout_id`).
CREATE TABLE IF NOT EXISTS fee_wallets (
  id                     TEXT PRIMARY KEY,
  chain_id               INTEGER NOT NULL,
  address                TEXT NOT NULL,
  label                  TEXT NOT NULL,
  active                 INTEGER NOT NULL DEFAULT 1,
  reserved_by_payout_id  TEXT,
  reserved_at            INTEGER,
  created_at             INTEGER NOT NULL,
  UNIQUE(chain_id, address)
);
CREATE INDEX IF NOT EXISTS idx_fee_wallets_available
  ON fee_wallets(chain_id, active, reserved_by_payout_id);

CREATE TABLE IF NOT EXISTS payouts (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  status                TEXT NOT NULL CHECK (status IN ('planned','reserved','submitted','confirmed','failed','canceled')),

  chain_id              INTEGER NOT NULL,
  token                 TEXT NOT NULL,
  amount_raw            TEXT NOT NULL,
  destination_address   TEXT NOT NULL,
  -- Null until a fee wallet is picked and CAS-reserved in `planned -> reserved`.
  source_address        TEXT,
  -- Null until broadcast succeeds in `reserved -> submitted`.
  tx_hash               TEXT,
  fee_estimate_native   TEXT,
  last_error            TEXT,

  created_at            INTEGER NOT NULL,
  submitted_at          INTEGER,
  confirmed_at          INTEGER,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payouts_merchant ON payouts(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status, chain_id);

-- Alchemy webhook registry. One row per (chain, webhook). Single source of
-- truth for HMAC signing keys — v1 shared a single env var across chains
-- and that approach fundamentally couldn't serve multi-chain (one string,
-- many webhooks). Storing per-chain here lets the inbound ingest route look
-- up the key by `webhookId` directly from the payload, matching Alchemy's
-- own routing and keeping the blast radius of any single compromise bounded.
CREATE TABLE IF NOT EXISTS alchemy_webhook_registry (
  chain_id      INTEGER PRIMARY KEY,
  -- Alchemy's own id (wh_...). UNIQUE so we can look up by id from the
  -- inbound payload without scanning.
  webhook_id    TEXT NOT NULL UNIQUE,
  -- AES-GCM ciphertext of the HMAC signing key returned by Alchemy on create,
  -- in the wire format produced by `SecretsCipher.encrypt` (`v1:<base64>`).
  -- Decrypted per request in the /webhooks/alchemy ingest handler; plaintext
  -- never lands in the DB.
  signing_key_ciphertext TEXT NOT NULL,
  webhook_url   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Alchemy address-subscription queue. Each row is one `add` or `remove`
-- operation against an Alchemy webhook's watched-addresses set. Event
-- subscribers enqueue rows with status='pending'; the cron sweep batches
-- pending rows by chain and POSTs one /update-webhook-addresses call per
-- chain. Follows v1's pattern (persistent state, decoupled cron) but adds a
-- max-attempts cap so permanently failing rows don't retry forever.
CREATE TABLE IF NOT EXISTS alchemy_address_subscriptions (
  id                TEXT PRIMARY KEY,
  chain_id          INTEGER NOT NULL,
  address           TEXT NOT NULL,
  -- 'add' (order created) or 'remove' (order reached a terminal state).
  action            TEXT NOT NULL CHECK (action IN ('add','remove')),
  -- pending  -> not yet synced with Alchemy
  -- synced   -> sync succeeded; row is historical (kept for audit)
  -- failed   -> max attempts exceeded; needs manual intervention
  status            TEXT NOT NULL CHECK (status IN ('pending','synced','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- Sweep filter index: find pending rows per chain that are due for retry.
CREATE INDEX IF NOT EXISTS idx_alchemy_subs_pending
  ON alchemy_address_subscriptions(status, chain_id, last_attempt_at);
