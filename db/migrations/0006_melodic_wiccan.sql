CREATE TABLE `opening_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`release_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`message_revision` integer,
	`snapshot_hash` text NOT NULL,
	`notice_version` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `recipients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opening_consent_unique` ON `opening_consents` (`delivery_id`,`user_id`,`snapshot_hash`,`notice_version`);--> statement-breakpoint
ALTER TABLE `deliveries` ADD `message_revision` integer;