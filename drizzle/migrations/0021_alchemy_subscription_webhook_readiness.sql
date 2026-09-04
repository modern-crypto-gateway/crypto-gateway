-- Bind a successful remote ADD to the concrete Alchemy webhook that accepted
-- it. Readiness must not treat an old webhook's `synced` marker as
-- proof that an address is present after the per-chain registry rotates to a
-- replacement webhook.
--
-- Nullable is intentional:
--   - pending/failed rows have not been proven against any webhook;
--   - effective removes are local no-ops and never carry remote proof;
--   - synced rows for a chain without a current registry entry cannot be
--     attributed safely and remain NULL;
--   - future successful ADD sweeps stamp the webhook id used for the API call.
ALTER TABLE `alchemy_address_subscriptions`
  ADD COLUMN `synced_webhook_id` text;
--> statement-breakpoint

-- Hot allocation-readiness prefix. SQLite stores each secondary-index entry
-- with its table rowid, so equality on (chain_id,address) also bounds newest-
-- row probes without duplicating lifecycle timestamps in the index.
CREATE INDEX IF NOT EXISTS `idx_alchemy_subs_chain_address`
  ON `alchemy_address_subscriptions` (`chain_id`, `address`);
--> statement-breakpoint

-- Deliberately do not backfill historical `synced` rows. Before this column
-- existed, registry.created_at was not rotated on webhook replacement, so no
-- local timestamp can prove which remote webhook contains an address. Legacy
-- rows remain NULL and allocation fails closed. The allocation repair path
-- appends fresh pending `add` markers for every non-retired pool address and
-- runs a bounded sweep; only a successful provider PATCH stamps the current
-- webhook id and opens readiness. Draining the regular sweep before enabling
-- traffic remains a safe operational rollout option.

-- Alchemy internal native transfers share a transaction hash but have no EVM
-- log index. Preserve the provider trace id as their stable discriminator;
-- ordinary native transfers retain the historical (chain,tx_hash) identity.
ALTER TABLE `transactions`
  ADD COLUMN `provider_transfer_id` text;
--> statement-breakpoint
DROP INDEX IF EXISTS `uq_transactions_identity_native`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transactions_identity_provider`
  ON `transactions` (`chain_id`, `tx_hash`, `provider_transfer_id`)
  WHERE `provider_transfer_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transactions_identity_native`
  ON `transactions` (`chain_id`, `tx_hash`)
  WHERE `log_index` IS NULL AND `provider_transfer_id` IS NULL;
