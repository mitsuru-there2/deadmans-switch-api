CREATE TABLE `store_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`store` text NOT NULL,
	`reference_hash` text NOT NULL,
	`reference` text NOT NULL,
	`product_id` text NOT NULL,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`valid_until` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`next_check_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_subscriptions_reference_hash_unique` ON `store_subscriptions` (`reference_hash`);--> statement-breakpoint
CREATE INDEX `subscription_profile_idx` ON `store_subscriptions` (`profile_id`);--> statement-breakpoint
CREATE INDEX `subscription_refresh_idx` ON `store_subscriptions` (`next_check_at`);