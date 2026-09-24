CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`condition` text NOT NULL,
	`threshold` text NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`channel` text DEFAULT 'app' NOT NULL,
	`created_at` text NOT NULL,
	`triggered_at` text,
	`triggered_price` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`currency` text NOT NULL,
	`price_source` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`isin` text,
	`exchange` text,
	`logo_url` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_symbol_currency_idx` ON `assets` (`symbol`,`currency`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`date` text NOT NULL,
	`currency` text NOT NULL,
	`rate_per_eur` text NOT NULL,
	`source` text DEFAULT 'ECB' NOT NULL,
	PRIMARY KEY(`date`, `currency`)
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`ok` integer,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE TABLE `platforms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'broker' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platforms_name_unique` ON `platforms` (`name`);--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`portfolio_id` integer NOT NULL,
	`date` text NOT NULL,
	`value_eur` text NOT NULL,
	`value_usd` text NOT NULL,
	`invested_eur` text NOT NULL,
	`invested_usd` text NOT NULL,
	PRIMARY KEY(`portfolio_id`, `date`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`ts` text NOT NULL,
	`day` text NOT NULL,
	`price` text NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`previous_close` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pq_asset_day_idx` ON `price_quotes` (`asset_id`,`day`);--> statement-breakpoint
CREATE INDEX `pq_asset_ts_idx` ON `price_quotes` (`asset_id`,`ts`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`subscription` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`encrypted_value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`portfolio_id` integer NOT NULL,
	`asset_id` integer,
	`platform_id` integer NOT NULL,
	`type` text NOT NULL,
	`quantity` text DEFAULT '0' NOT NULL,
	`price` text DEFAULT '0' NOT NULL,
	`currency` text NOT NULL,
	`fee` text DEFAULT '0' NOT NULL,
	`fee_currency` text,
	`executed_at` text NOT NULL,
	`fx_eur` text,
	`fx_usd` text,
	`note` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`external_id` text,
	`hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tx_portfolio_idx` ON `transactions` (`portfolio_id`);--> statement-breakpoint
CREATE INDEX `tx_asset_idx` ON `transactions` (`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tx_hash_idx` ON `transactions` (`hash`);--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`date` text NOT NULL,
	`value` text NOT NULL,
	`currency` text NOT NULL,
	`debt` text DEFAULT '0' NOT NULL,
	`note` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `val_asset_idx` ON `valuations` (`asset_id`);