CREATE TABLE `balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`currency` text NOT NULL,
	`amount` text NOT NULL,
	`hold` text DEFAULT '0' NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balances_conn_ccy_idx` ON `balances` (`connection_id`,`currency`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`platform_id` integer NOT NULL,
	`portfolio_id` integer NOT NULL,
	`account_type` text DEFAULT 'real' NOT NULL,
	`mode` text DEFAULT 'replace' NOT NULL,
	`status` text DEFAULT 'never' NOT NULL,
	`last_sync_at` text,
	`last_error` text,
	`cursor` text,
	`reconciliation` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`ok` integer,
	`created` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`message` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `provider_ids` text;