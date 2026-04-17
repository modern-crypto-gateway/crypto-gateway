CREATE TABLE `address_index_counters` (
	`chain_id` integer PRIMARY KEY NOT NULL,
	`next_index` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `address_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`family` text NOT NULL,
	`address_index` integer NOT NULL,
	`address` text NOT NULL,
	`status` text NOT NULL,
	`allocated_to_invoice_id` text,
	`allocated_at` integer,
	`total_allocations` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "address_pool_family_check" CHECK("address_pool"."family" IN ('evm','tron','solana')),
	CONSTRAINT "address_pool_status_check" CHECK("address_pool"."status" IN ('available','allocated','quarantined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_address_pool_family_index` ON `address_pool` (`family`,`address_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_address_pool_family_address` ON `address_pool` (`family`,`address`);--> statement-breakpoint
CREATE INDEX `idx_address_pool_available` ON `address_pool` (`family`,`status`,`total_allocations`,`address_index`);--> statement-breakpoint
CREATE INDEX `idx_address_pool_allocated` ON `address_pool` (`allocated_to_invoice_id`);--> statement-breakpoint
CREATE TABLE `alchemy_address_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`address` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "alchemy_subs_action_check" CHECK("alchemy_address_subscriptions"."action" IN ('add','remove')),
	CONSTRAINT "alchemy_subs_status_check" CHECK("alchemy_address_subscriptions"."status" IN ('pending','synced','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_alchemy_subs_pending` ON `alchemy_address_subscriptions` (`status`,`chain_id`,`last_attempt_at`);--> statement-breakpoint
CREATE TABLE `alchemy_webhook_registry` (
	`chain_id` integer PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`signing_key_ciphertext` text NOT NULL,
	`webhook_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alchemy_webhook_registry_webhook_id_unique` ON `alchemy_webhook_registry` (`webhook_id`);--> statement-breakpoint
CREATE TABLE `fee_wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`address` text NOT NULL,
	`label` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`reserved_by_payout_id` text,
	`reserved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_fee_wallets_chain_address` ON `fee_wallets` (`chain_id`,`address`);--> statement-breakpoint
CREATE INDEX `idx_fee_wallets_available` ON `fee_wallets` (`chain_id`,`active`,`reserved_by_payout_id`);--> statement-breakpoint
CREATE TABLE `invoice_receive_addresses` (
	`invoice_id` text NOT NULL,
	`family` text NOT NULL,
	`address` text NOT NULL,
	`pool_address_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`invoice_id`, `family`),
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pool_address_id`) REFERENCES `address_pool`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_rx_family_check" CHECK("invoice_receive_addresses"."family" IN ('evm','tron','solana'))
);
--> statement-breakpoint
CREATE INDEX `idx_invoice_rx_address` ON `invoice_receive_addresses` (`address`);--> statement-breakpoint
CREATE INDEX `idx_invoice_rx_pool` ON `invoice_receive_addresses` (`pool_address_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`status` text NOT NULL,
	`chain_id` integer NOT NULL,
	`token` text NOT NULL,
	`receive_address` text NOT NULL,
	`address_index` integer NOT NULL,
	`required_amount_raw` text NOT NULL,
	`received_amount_raw` text DEFAULT '0' NOT NULL,
	`fiat_amount` text,
	`fiat_currency` text,
	`quoted_rate` text,
	`external_id` text,
	`metadata_json` text,
	`accepted_families` text,
	`amount_usd` text,
	`paid_usd` text DEFAULT '0' NOT NULL,
	`overpaid_usd` text DEFAULT '0' NOT NULL,
	`rate_window_expires_at` integer,
	`rates_json` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_status_check" CHECK("invoices"."status" IN ('created','partial','detected','confirmed','overpaid','expired','canceled'))
);
--> statement-breakpoint
CREATE INDEX `idx_invoices_merchant` ON `invoices` (`merchant_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_invoices_status` ON `invoices` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_invoices_receive_address` ON `invoices` (`chain_id`,`receive_address`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_invoices_external_id` ON `invoices` (`merchant_id`,`external_id`) WHERE "invoices"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`api_key_hash` text NOT NULL,
	`webhook_url` text,
	`webhook_secret_ciphertext` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_api_key_hash_unique` ON `merchants` (`api_key_hash`);--> statement-breakpoint
CREATE INDEX `idx_merchants_api_key_hash` ON `merchants` (`api_key_hash`);--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`status` text NOT NULL,
	`chain_id` integer NOT NULL,
	`token` text NOT NULL,
	`amount_raw` text NOT NULL,
	`destination_address` text NOT NULL,
	`source_address` text,
	`tx_hash` text,
	`fee_estimate_native` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	`confirmed_at` integer,
	`updated_at` integer NOT NULL,
	`broadcast_attempted_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payouts_status_check" CHECK("payouts"."status" IN ('planned','reserved','submitted','confirmed','failed','canceled'))
);
--> statement-breakpoint
CREATE INDEX `idx_payouts_merchant` ON `payouts` (`merchant_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_payouts_status` ON `payouts` (`status`,`chain_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text,
	`chain_id` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`log_index` integer,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`token` text NOT NULL,
	`amount_raw` text NOT NULL,
	`block_number` integer,
	`confirmations` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`detected_at` integer NOT NULL,
	`confirmed_at` integer,
	`amount_usd` text,
	`usd_rate` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_status_check" CHECK("transactions"."status" IN ('detected','confirmed','reverted','orphaned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transactions_identity` ON `transactions` (`chain_id`,`tx_hash`,`log_index`) WHERE "transactions"."log_index" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transactions_identity_native` ON `transactions` (`chain_id`,`tx_hash`) WHERE "transactions"."log_index" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_transactions_invoice` ON `transactions` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_status` ON `transactions` (`status`,`chain_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`event_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`target_url` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_status_code` integer,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_deliveries_status_check" CHECK("webhook_deliveries"."status" IN ('pending','delivered','dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_idempotency_key_unique` ON `webhook_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_status_next` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_merchant` ON `webhook_deliveries` (`merchant_id`,"created_at" DESC);