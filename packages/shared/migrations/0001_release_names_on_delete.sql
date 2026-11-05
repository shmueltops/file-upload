DROP INDEX `files_active_name`;--> statement-breakpoint
-- Drizzle Kit 0.31.11 splits COALESCE expressions incorrectly; keep this reviewed SQL.
CREATE UNIQUE INDEX `files_active_name` ON `files` (`user_id`,coalesce("folder_id", ''),`filename_key`) WHERE "files"."deleted_at" IS NULL AND "files"."delete_requested_at" IS NULL;--> statement-breakpoint
DROP INDEX `folders_active_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `folders_active_name` ON `folders` (`user_id`,coalesce("parent_id", ''),`name_key`) WHERE "folders"."deleted_at" IS NULL AND "folders"."delete_requested_at" IS NULL;
