-- void:allow-destructive
ALTER TABLE `outbox` ADD `device_id` text REFERENCES devices(id);--> statement-breakpoint
ALTER TABLE `recipients` DROP COLUMN `access_code_hash`;