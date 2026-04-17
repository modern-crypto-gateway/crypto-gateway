-- A1: Address pool + multi-family order acceptance.
--
-- Shifts the HD-derivation model from "one address per order" to "pool of
-- pre-derived addresses reused across orders". Reuse saves gas: sweeping
-- 100 orders → 1 consolidated sweep instead of 100 individual sweeps, which
-- makes tiny-amount orders on expensive chains (ETH with $5+ gas) actually
-- viable.
--
-- The pool is keyed by FAMILY (evm/tron/solana) because EVM addresses are
-- identical across all 7 EVM chains — one HD-derived pubkey gets the same
-- base58/hex representation on ETH, OP, Polygon, Base, Arbitrum, AVAX, and
-- BSC. So one pool row covers an entire family's worth of chains, and the
-- alchemy_address_subscriptions table (per-chain) handles webhook fan-out.
--
-- Orders gain `accepted_families` so a merchant can say "I'll take payment
-- on any EVM chain + Tron" — payer picks their preferred chain at checkout.

CREATE TABLE IF NOT EXISTS address_pool (
  id                     TEXT PRIMARY KEY,
  -- 'evm' | 'tron' | 'solana'. Unique derivation path per family.
  family                 TEXT NOT NULL CHECK (family IN ('evm','tron','solana')),
  -- BIP32/SLIP-0010 index used to derive `address` from MASTER_SEED.
  -- Monotonic per family. The refill path takes MAX(address_index)+1 under
  -- a cache-backed mutex so concurrent refills don't collide.
  address_index          INTEGER NOT NULL,
  -- Canonical form: hex for EVM, base58 for Tron, base58 for Solana.
  address                TEXT NOT NULL,
  -- 'available' : free to allocate to the next incoming order
  -- 'allocated' : currently tied to an order (see allocated_to_order_id)
  -- 'quarantined': pulled out of rotation by ops action (compromise, audit)
  status                 TEXT NOT NULL
                         CHECK (status IN ('available','allocated','quarantined')),
  allocated_to_order_id  TEXT,
  allocated_at           INTEGER,
  -- Lifetime reuse counter. Drives fair rotation: allocation picks the row
  -- with the LOWEST total_allocations first, so the same address doesn't
  -- get re-handed-out disproportionately.
  total_allocations      INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  UNIQUE (family, address_index),
  UNIQUE (family, address)
);

-- Allocation query: `WHERE family=? AND status='available' ORDER BY
-- total_allocations ASC, address_index ASC LIMIT 1`.
CREATE INDEX IF NOT EXISTS idx_address_pool_available
  ON address_pool(family, status, total_allocations, address_index);

-- Reverse lookup for pool admin + release-on-order-terminal.
CREATE INDEX IF NOT EXISTS idx_address_pool_allocated
  ON address_pool(allocated_to_order_id);

-- Per-order mapping of family → receive address. A multi-family order has
-- one row per accepted family. Detection matches incoming transfers by
-- address + family (derived from chainId). Primary key is (order_id, family)
-- so an order can't have two addresses in the same family.
CREATE TABLE IF NOT EXISTS order_receive_addresses (
  order_id         TEXT NOT NULL REFERENCES orders(id),
  family           TEXT NOT NULL CHECK (family IN ('evm','tron','solana')),
  address          TEXT NOT NULL,
  pool_address_id  TEXT NOT NULL REFERENCES address_pool(id),
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (order_id, family)
);
CREATE INDEX IF NOT EXISTS idx_order_rx_address ON order_receive_addresses(address);
CREATE INDEX IF NOT EXISTS idx_order_rx_pool ON order_receive_addresses(pool_address_id);

-- Extend orders with the accepted-families list. JSON array of strings like
-- `["evm","tron"]`. NULL for legacy single-chain orders written before this
-- migration ran.
ALTER TABLE orders ADD COLUMN accepted_families TEXT;
