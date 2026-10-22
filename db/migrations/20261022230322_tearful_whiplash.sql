CREATE TABLE `_d1_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
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
