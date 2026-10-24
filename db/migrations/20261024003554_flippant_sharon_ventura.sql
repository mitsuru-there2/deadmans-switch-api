CREATE TABLE `auth_link_bindings` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `email_changes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`credential_id` text NOT NULL,
	`email` text NOT NULL,
	`old_email` text NOT NULL,
	`generation` integer NOT NULL,
	`step` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `device_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_changes_id_unique` ON `email_changes` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_changes_token_hash_unique` ON `email_changes` (`token_hash`);--> statement-breakpoint
ALTER TABLE `device_credentials` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `name` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `platform` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `credential_id` text REFERENCES device_credentials(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_credential_id_unique` ON `devices` (`credential_id`);--> statement-breakpoint
ALTER TABLE `session` ADD `auth_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `auth_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `self_test_required_after` integer;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_email_changes_insert` AFTER INSERT ON `email_changes` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;

--> statement-breakpoint
CREATE TRIGGER `_d1_revision_email_changes_update` AFTER UPDATE ON `email_changes` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;

--> statement-breakpoint
CREATE TRIGGER `_d1_revision_email_changes_delete` AFTER DELETE ON `email_changes` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;

--> statement-breakpoint
CREATE TRIGGER `_d1_revision_auth_link_bindings_insert` AFTER INSERT ON `auth_link_bindings` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;

--> statement-breakpoint
CREATE TRIGGER `_d1_revision_auth_link_bindings_update` AFTER UPDATE ON `auth_link_bindings` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;

--> statement-breakpoint
CREATE TRIGGER `_d1_revision_auth_link_bindings_delete` AFTER DELETE ON `auth_link_bindings` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
