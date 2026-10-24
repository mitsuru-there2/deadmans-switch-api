CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`action` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_profile_idx` ON `audit` (`profile_id`,`created_at`);--> statement-breakpoint
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
CREATE TABLE `contact_verifications` (
	`user_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_verifications_token_hash_unique` ON `contact_verifications` (`token_hash`);--> statement-breakpoint
CREATE TABLE `_d1_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`token_hash` text NOT NULL,
	`message_revision` integer,
	`expires_at` integer NOT NULL,
	`viewed_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `recipients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_token_hash_unique` ON `deliveries` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_recipient_unique` ON `deliveries` (`release_id`,`recipient_id`);--> statement-breakpoint
CREATE TABLE `device_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_credentials_token_hash_unique` ON `device_credentials` (`token_hash`);--> statement-breakpoint
CREATE INDEX `device_credentials_user_idx` ON `device_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`token` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`name` text,
	`platform` text,
	`credential_id` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `device_credentials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_credential_id_unique` ON `devices` (`credential_id`);--> statement-breakpoint
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
CREATE TABLE `entitlements` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`valid_until` integer NOT NULL,
	`source_version` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `recipients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_recipient_id_unique` ON `messages` (`recipient_id`);--> statement-breakpoint
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
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text,
	`recipient_id` text,
	`device_id` text,
	`version` integer,
	`contact_generation` integer,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`claimed_at` integer,
	`provider_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `recipients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_dedupe_key_unique` ON `outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`state`,`available_at`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`inactivity_days` integer DEFAULT 30 NOT NULL,
	`grace_days` integer DEFAULT 7 NOT NULL,
	`last_check_in_at` integer,
	`grace_started_at` integer,
	`warning_accepted_at` integer,
	`last_reminder_at` integer,
	`hold_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_user_id_unique` ON `profiles` (`user_id`);--> statement-breakpoint
CREATE INDEX `profile_state_idx` ON `profiles` (`state`);--> statement-breakpoint
CREATE TABLE `public_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`channel` text NOT NULL,
	`contact` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invitation_hash` text,
	`invitation_expires_at` integer,
	`accepted_at` integer,
	`last_invited_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipients_invitation_hash_unique` ON `recipients` (`invitation_hash`);--> statement-breakpoint
CREATE INDEX `recipient_profile_idx` ON `recipients` (`profile_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_version_unique` ON `releases` (`profile_id`,`version`);--> statement-breakpoint
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
CREATE INDEX `restore_operations_purge_idx` ON `restore_operations` (`purge_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`auth_generation` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `store_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`store` text NOT NULL,
	`reference_hash` text NOT NULL,
	`linked_reference_hash` text,
	`reference` text NOT NULL,
	`product_id` text NOT NULL,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`valid_until` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`owner_verified_at` integer,
	`next_check_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_subscriptions_reference_hash_unique` ON `store_subscriptions` (`reference_hash`);--> statement-breakpoint
CREATE INDEX `subscription_profile_idx` ON `store_subscriptions` (`profile_id`);--> statement-breakpoint
CREATE INDEX `subscription_refresh_idx` ON `store_subscriptions` (`next_check_at`);--> statement-breakpoint
CREATE TABLE `system_health` (
	`id` text PRIMARY KEY NOT NULL,
	`last_tick_at` integer,
	`last_probe_at` integer,
	`incident_at` integer,
	`recovered_at` integer
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`auth_generation` integer DEFAULT 0 NOT NULL,
	`self_test_required_after` integer,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);

--> statement-breakpoint
-- D1 optimistic concurrency requires this row and revision triggers.
INSERT INTO `_d1_revision` (`id`, `revision`) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_user_insert` AFTER INSERT ON `user` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_user_update` AFTER UPDATE ON `user` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_user_delete` AFTER DELETE ON `user` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_device_credentials_insert` AFTER INSERT ON `device_credentials` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_device_credentials_update` AFTER UPDATE ON `device_credentials` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_device_credentials_delete` AFTER DELETE ON `device_credentials` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_contact_verifications_insert` AFTER INSERT ON `contact_verifications` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_contact_verifications_update` AFTER UPDATE ON `contact_verifications` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_contact_verifications_delete` AFTER DELETE ON `contact_verifications` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_restore_operations_insert` AFTER INSERT ON `restore_operations` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_restore_operations_update` AFTER UPDATE ON `restore_operations` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_restore_operations_delete` AFTER DELETE ON `restore_operations` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_session_insert` AFTER INSERT ON `session` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_session_update` AFTER UPDATE ON `session` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_session_delete` AFTER DELETE ON `session` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_account_insert` AFTER INSERT ON `account` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_account_update` AFTER UPDATE ON `account` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_account_delete` AFTER DELETE ON `account` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_verification_insert` AFTER INSERT ON `verification` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_verification_update` AFTER UPDATE ON `verification` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_verification_delete` AFTER DELETE ON `verification` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_rate_limit_insert` AFTER INSERT ON `rate_limit` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_rate_limit_update` AFTER UPDATE ON `rate_limit` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_rate_limit_delete` AFTER DELETE ON `rate_limit` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_profiles_insert` AFTER INSERT ON `profiles` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_profiles_update` AFTER UPDATE ON `profiles` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_profiles_delete` AFTER DELETE ON `profiles` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_recipients_insert` AFTER INSERT ON `recipients` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_recipients_update` AFTER UPDATE ON `recipients` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_recipients_delete` AFTER DELETE ON `recipients` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_messages_insert` AFTER INSERT ON `messages` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_messages_update` AFTER UPDATE ON `messages` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_messages_delete` AFTER DELETE ON `messages` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_devices_insert` AFTER INSERT ON `devices` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_devices_update` AFTER UPDATE ON `devices` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_devices_delete` AFTER DELETE ON `devices` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_entitlements_insert` AFTER INSERT ON `entitlements` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_entitlements_update` AFTER UPDATE ON `entitlements` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_entitlements_delete` AFTER DELETE ON `entitlements` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_releases_insert` AFTER INSERT ON `releases` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_releases_update` AFTER UPDATE ON `releases` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_releases_delete` AFTER DELETE ON `releases` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_deliveries_insert` AFTER INSERT ON `deliveries` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_deliveries_update` AFTER UPDATE ON `deliveries` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_deliveries_delete` AFTER DELETE ON `deliveries` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_opening_consents_insert` AFTER INSERT ON `opening_consents` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_opening_consents_update` AFTER UPDATE ON `opening_consents` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_opening_consents_delete` AFTER DELETE ON `opening_consents` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_outbox_insert` AFTER INSERT ON `outbox` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_outbox_update` AFTER UPDATE ON `outbox` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_outbox_delete` AFTER DELETE ON `outbox` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_audit_insert` AFTER INSERT ON `audit` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_audit_update` AFTER UPDATE ON `audit` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_audit_delete` AFTER DELETE ON `audit` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_system_health_insert` AFTER INSERT ON `system_health` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_system_health_update` AFTER UPDATE ON `system_health` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_system_health_delete` AFTER DELETE ON `system_health` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_webhook_events_insert` AFTER INSERT ON `webhook_events` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_webhook_events_update` AFTER UPDATE ON `webhook_events` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_webhook_events_delete` AFTER DELETE ON `webhook_events` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_public_rate_limits_insert` AFTER INSERT ON `public_rate_limits` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_public_rate_limits_update` AFTER UPDATE ON `public_rate_limits` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_public_rate_limits_delete` AFTER DELETE ON `public_rate_limits` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_store_subscriptions_insert` AFTER INSERT ON `store_subscriptions` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_store_subscriptions_update` AFTER UPDATE ON `store_subscriptions` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER `_d1_revision_store_subscriptions_delete` AFTER DELETE ON `store_subscriptions` BEGIN UPDATE `_d1_revision` SET revision = revision + 1 WHERE id = 1; END;
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
--> statement-breakpoint
