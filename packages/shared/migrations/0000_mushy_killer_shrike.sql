CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`folder_id` text,
	`filename` text NOT NULL,
	`filename_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`expected_size` integer NOT NULL,
	`actual_size` integer,
	`upload_generation` text NOT NULL,
	`upload_kind` text NOT NULL,
	`quarantine_key` text NOT NULL,
	`multipart_upload_id` text,
	`upload_expires_at` integer NOT NULL,
	`latest_signed_url_expires_at` integer NOT NULL,
	`source_etag` text,
	`approved_source_etag` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`stage` text DEFAULT 'verify' NOT NULL,
	`scan_attempt_count` integer DEFAULT 0 NOT NULL,
	`scan_verdict` text,
	`claim_token` text,
	`lease_expires_at` integer,
	`clean_key` text,
	`clean_etag` text,
	`block_reason` text,
	`last_error_code` text,
	`last_error` text,
	`cleanup_attempt_count` integer DEFAULT 0 NOT NULL,
	`cleanup_after` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`upload_completed_at` integer,
	`processing_started_at` integer,
	`last_processed_at` integer,
	`completed_at` integer,
	`delete_requested_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`folder_id`) REFERENCES `folders`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "files_sizes" CHECK("files"."expected_size" BETWEEN 0 AND 3000000000 AND ("files"."actual_size" IS NULL OR "files"."actual_size" >= 0)),
	CONSTRAINT "files_attempt_limit" CHECK("files"."scan_attempt_count" BETWEEN 0 AND 3),
	CONSTRAINT "files_status_check" CHECK("files"."status" IN ('pending','uploading','scanning','retrying','processing','done','infected','failed','deleting','deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_owner_id` ON `files` (`user_id`,`id`);--> statement-breakpoint
-- Reviewed correction: Drizzle Kit 0.31.11 splits expression-index SQL on commas.
CREATE UNIQUE INDEX `files_active_name` ON `files` (`user_id`,coalesce(`folder_id`, ''),`filename_key`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `files_folder` ON `files` (`user_id`,`folder_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `files_status` ON `files` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `files_lease` ON `files` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `files_deletion` ON `files` (`delete_requested_at`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delete_requested_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`parent_id`) REFERENCES `folders`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_owner_id` ON `folders` (`user_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `folders_active_name` ON `folders` (`user_id`,coalesce(`parent_id`, ''),`name_key`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `folders_parent` ON `folders` (`user_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `scan_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`upload_generation` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`claim_token` text NOT NULL,
	`provider` text NOT NULL,
	`result` text NOT NULL,
	`duration_ms` integer,
	`provider_response` text,
	`error_code` text,
	`error_details` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_range" CHECK("scan_attempts"."attempt_number" BETWEEN 1 AND 3),
	CONSTRAINT "attempt_result" CHECK("scan_attempts"."result" IN ('started','clean','infected','error','interrupted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_number` ON `scan_attempts` (`file_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_key` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`session_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`password_changed_at` integer,
	`last_login_at` integer,
	CONSTRAINT "users_role" CHECK("users"."role" IN ('user','admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email` ON `users` (`email_key`);
