-- A2.a: USD-pegged order amounts + per-payment USD conversion + rolling
-- rate windows + `overpaid` order status.
--
-- A USD-path order stores its target as `amount_usd` (decimal string),
-- snapshots the current USD rates for every token it can accept into
-- `rates_json` at creation, and refreshes the snapshot every 10 minutes
-- at detection time (`rate_window_expires_at`). Each detected transfer
-- converts raw token amount → USD at the rate pinned on the window it
-- lands in, writes that USD value to `transactions.amount_usd`, and
-- aggregates into `orders.paid_usd`. When paid_usd exceeds amount_usd,
-- the excess lives in `overpaid_usd` and status flips to 'overpaid'.
--
-- Legacy single-token orders (created with `amountRaw`) keep working:
-- their `amount_usd` stays NULL and detection aggregates into
-- `received_amount_raw` as before. The USD path is additive.

-- ---- Orders: USD fields (additive ALTERs) ----

ALTER TABLE orders ADD COLUMN amount_usd TEXT;
ALTER TABLE orders ADD COLUMN paid_usd TEXT NOT NULL DEFAULT '0';
ALTER TABLE orders ADD COLUMN overpaid_usd TEXT NOT NULL DEFAULT '0';
ALTER TABLE orders ADD COLUMN rate_window_expires_at INTEGER;
ALTER TABLE orders ADD COLUMN rates_json TEXT;

-- ---- Transactions: per-payment USD value + rate used ----

ALTER TABLE transactions ADD COLUMN amount_usd TEXT;
ALTER TABLE transactions ADD COLUMN usd_rate TEXT;

-- ---- Status enum: add 'overpaid' via build-new-drop-old pattern ----
--
-- SQLite doesn't let us ALTER an existing CHECK constraint, so we rebuild.
-- FK integrity is disabled for the swap so dropping `orders` doesn't trip
-- `order_receive_addresses`' reference. The RENAME at the end rebinds the
-- FK name to the new table.

PRAGMA foreign_keys = OFF;

CREATE TABLE orders_new (
  id                       TEXT PRIMARY KEY,
  merchant_id              TEXT NOT NULL REFERENCES merchants(id),
  status                   TEXT NOT NULL CHECK (status IN (
    'created','partial','detected','confirmed','overpaid','expired','canceled'
  )),

  chain_id                 INTEGER NOT NULL,
  token                    TEXT NOT NULL,
  receive_address          TEXT NOT NULL,
  address_index            INTEGER NOT NULL,

  required_amount_raw      TEXT NOT NULL,
  received_amount_raw      TEXT NOT NULL DEFAULT '0',

  fiat_amount              TEXT,
  fiat_currency            TEXT,
  quoted_rate              TEXT,

  external_id              TEXT,
  metadata_json            TEXT,

  accepted_families        TEXT,

  amount_usd               TEXT,
  paid_usd                 TEXT NOT NULL DEFAULT '0',
  overpaid_usd             TEXT NOT NULL DEFAULT '0',
  rate_window_expires_at   INTEGER,
  rates_json               TEXT,

  created_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  confirmed_at             INTEGER,
  updated_at               INTEGER NOT NULL
);

INSERT INTO orders_new (
  id, merchant_id, status, chain_id, token, receive_address, address_index,
  required_amount_raw, received_amount_raw, fiat_amount, fiat_currency,
  quoted_rate, external_id, metadata_json, accepted_families,
  amount_usd, paid_usd, overpaid_usd, rate_window_expires_at, rates_json,
  created_at, expires_at, confirmed_at, updated_at
)
SELECT
  id, merchant_id, status, chain_id, token, receive_address, address_index,
  required_amount_raw, received_amount_raw, fiat_amount, fiat_currency,
  quoted_rate, external_id, metadata_json, accepted_families,
  amount_usd, paid_usd, overpaid_usd, rate_window_expires_at, rates_json,
  created_at, expires_at, confirmed_at, updated_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Re-create indexes — SQLite drops them with the table.
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_receive_address ON orders(chain_id, receive_address);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_external_id ON orders(merchant_id, external_id) WHERE external_id IS NOT NULL;

PRAGMA foreign_keys = ON;
