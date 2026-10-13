-- SQLite ADD COLUMN in the preceding generated migration omitted the deletion action.
-- Rebuild the child table, retaining the delivery ledger, to match the Drizzle schema.
CREATE TABLE `outbox_new` (
  `id` text PRIMARY KEY NOT NULL,
  `profile_id` text REFERENCES `profiles`(`id`) ON DELETE cascade,
  `recipient_id` text REFERENCES `recipients`(`id`) ON DELETE cascade,
  `device_id` text REFERENCES `devices`(`id`) ON DELETE set null,
  `version` integer,
  `kind` text NOT NULL,
  `dedupe_key` text NOT NULL,
  `payload` text NOT NULL,
  `state` text DEFAULT 'pending' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `available_at` integer NOT NULL,
  `claimed_at` integer,
  `provider_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `outbox_new` (`id`, `profile_id`, `recipient_id`, `device_id`, `version`, `kind`, `dedupe_key`, `payload`, `state`, `attempts`, `available_at`, `claimed_at`, `provider_id`, `created_at`)
SELECT `id`, `profile_id`, `recipient_id`, `device_id`, `version`, `kind`, `dedupe_key`, `payload`, `state`, `attempts`, `available_at`, `claimed_at`, `provider_id`, `created_at` FROM `outbox`;
--> statement-breakpoint
DROP TABLE `outbox`;
--> statement-breakpoint
ALTER TABLE `outbox_new` RENAME TO `outbox`;
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_dedupe_key_unique` ON `outbox` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`state`, `available_at`);
