CREATE TABLE `wallet_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`script_type` text NOT NULL,
	`label` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`receive_used` integer DEFAULT 0 NOT NULL,
	`change_used` integer DEFAULT 0 NOT NULL,
	`tx_count` integer DEFAULT 0 NOT NULL,
	`balance_confirmed` text DEFAULT '0' NOT NULL,
	`balance_unconfirmed` text DEFAULT '0' NOT NULL,
	`last_scan_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_accounts_conn_key_idx` ON `wallet_accounts` (`connection_id`,`fingerprint`,`script_type`);