-- A3.a: Rename "order" → "invoice" across the schema.
--
-- Product reasoning: an Order in our domain always referred to a fixed-amount
-- payment request from a merchant to a customer — exactly the semantics of an
-- invoice in every accounting system on earth. The "order" label confused
-- merchants (who track their own orders separately, unrelated to our object)
-- and forced awkward explanations. "Invoice" just reads right.
--
-- Mechanics: SQLite 3.25+ supports `ALTER TABLE ... RENAME COLUMN` and also
-- updates FK references in dependent tables when the target table is renamed,
-- provided `legacy_alter_table = OFF` (the default in modern SQLite). So we can
-- rename tables + columns in place without a full rebuild.
--
-- FOREIGN KEY notes:
--   - `transactions.order_id REFERENCES orders(id)` → FK is rewritten to
--     `invoices(id)` by the ALTER TABLE RENAME on `orders`. We then rename the
--     column on `transactions` to `invoice_id`.
--   - `order_receive_addresses.order_id REFERENCES orders(id)` — same story.
--
-- We toggle foreign_keys OFF for the duration so mid-rename reference
-- inconsistency doesn't trip the checker on libSQL.

PRAGMA foreign_keys = OFF;

-- ---- Tables ----
ALTER TABLE orders RENAME TO invoices;
ALTER TABLE order_receive_addresses RENAME TO invoice_receive_addresses;

-- ---- Columns referencing "order" ----
ALTER TABLE invoice_receive_addresses RENAME COLUMN order_id TO invoice_id;
ALTER TABLE transactions RENAME COLUMN order_id TO invoice_id;
ALTER TABLE address_pool RENAME COLUMN allocated_to_order_id TO allocated_to_invoice_id;

-- ---- Indexes (SQLite doesn't rename these when the table is renamed) ----
DROP INDEX IF EXISTS idx_orders_merchant;
DROP INDEX IF EXISTS idx_orders_status;
DROP INDEX IF EXISTS idx_orders_receive_address;
DROP INDEX IF EXISTS uq_orders_external_id;
DROP INDEX IF EXISTS idx_transactions_order;
DROP INDEX IF EXISTS idx_order_rx_address;
DROP INDEX IF EXISTS idx_order_rx_pool;
DROP INDEX IF EXISTS idx_address_pool_allocated;

CREATE INDEX IF NOT EXISTS idx_invoices_merchant ON invoices(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_invoices_receive_address ON invoices(chain_id, receive_address);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_external_id ON invoices(merchant_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_invoice ON transactions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_rx_address ON invoice_receive_addresses(address);
CREATE INDEX IF NOT EXISTS idx_invoice_rx_pool ON invoice_receive_addresses(pool_address_id);
CREATE INDEX IF NOT EXISTS idx_address_pool_allocated ON address_pool(allocated_to_invoice_id);

PRAGMA foreign_keys = ON;
