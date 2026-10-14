CREATE TABLE `restore_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`source_token_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`result_token_hash` text,
	`target_user_id` text,
	`error_code` text,
	`expires_at` integer NOT NULL,
	`purge_at` integer NOT NULL,
	FOREIGN KEY (`target_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restore_operations_secret_hash_unique` ON `restore_operations` (`secret_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `restore_operations_source_token_hash_unique` ON `restore_operations` (`source_token_hash`);--> statement-breakpoint
CREATE INDEX `restore_operations_expiry_idx` ON `restore_operations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `restore_operations_purge_idx` ON `restore_operations` (`purge_at`);