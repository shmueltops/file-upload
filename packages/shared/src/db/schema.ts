import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    email: text().notNull(),
    email_key: text().notNull(),
    password_hash: text().notNull(),
    role: text({ enum: ['user', 'admin'] })
      .notNull()
      .default('user'),
    must_change_password: integer({ mode: 'boolean' }).notNull().default(true),
    session_version: integer().notNull().default(0),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    password_changed_at: integer(),
    last_login_at: integer(),
  },
  (t) => [
    uniqueIndex('users_email').on(t.email_key),
    check('users_role', sql`${t.role} IN ('user','admin')`),
  ],
);
export const folders = sqliteTable(
  'folders',
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id),
    parent_id: text(),
    name: text().notNull(),
    name_key: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    delete_requested_at: integer(),
    deleted_at: integer(),
  },
  (t) => [
    uniqueIndex('folders_owner_id').on(t.user_id, t.id),
    foreignKey({ columns: [t.user_id, t.parent_id], foreignColumns: [t.user_id, t.id] }),
    uniqueIndex('folders_active_name')
      .on(t.user_id, sql`coalesce(${t.parent_id}, '')`, t.name_key)
      .where(sql`${t.deleted_at} IS NULL`),
    index('folders_parent').on(t.user_id, t.parent_id),
  ],
);
export const files = sqliteTable(
  'files',
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => users.id),
    folder_id: text(),
    filename: text().notNull(),
    filename_key: text().notNull(),
    mime_type: text().notNull(),
    expected_size: integer().notNull(),
    actual_size: integer(),
    upload_generation: text().notNull(),
    upload_kind: text({ enum: ['single', 'multipart'] }).notNull(),
    quarantine_key: text().notNull(),
    multipart_upload_id: text(),
    upload_expires_at: integer().notNull(),
    latest_signed_url_expires_at: integer().notNull(),
    source_etag: text(),
    approved_source_etag: text(),
    status: text({
      enum: [
        'pending',
        'uploading',
        'scanning',
        'retrying',
        'processing',
        'done',
        'infected',
        'failed',
        'deleting',
        'deleted',
      ],
    })
      .notNull()
      .default('pending'),
    stage: text().notNull().default('verify'),
    scan_attempt_count: integer().notNull().default(0),
    scan_verdict: text(),
    claim_token: text(),
    lease_expires_at: integer(),
    clean_key: text(),
    clean_etag: text(),
    block_reason: text(),
    last_error_code: text(),
    last_error: text(),
    cleanup_attempt_count: integer().notNull().default(0),
    cleanup_after: integer().notNull().default(0),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    upload_completed_at: integer(),
    processing_started_at: integer(),
    last_processed_at: integer(),
    completed_at: integer(),
    delete_requested_at: integer(),
    deleted_at: integer(),
  },
  (t) => [
    uniqueIndex('files_owner_id').on(t.user_id, t.id),
    foreignKey({
      columns: [t.user_id, t.folder_id],
      foreignColumns: [folders.user_id, folders.id],
    }),
    uniqueIndex('files_active_name')
      .on(t.user_id, sql`coalesce(${t.folder_id}, '')`, t.filename_key)
      .where(sql`${t.deleted_at} IS NULL`),
    index('files_folder').on(t.user_id, t.folder_id, t.created_at, t.id),
    index('files_status').on(t.status, t.updated_at),
    index('files_lease').on(t.lease_expires_at),
    index('files_deletion').on(t.delete_requested_at, t.deleted_at),
    check(
      'files_sizes',
      sql`${t.expected_size} BETWEEN 0 AND 3000000000 AND (${t.actual_size} IS NULL OR ${t.actual_size} >= 0)`,
    ),
    check('files_attempt_limit', sql`${t.scan_attempt_count} BETWEEN 0 AND 3`),
    check(
      'files_status_check',
      sql`${t.status} IN ('pending','uploading','scanning','retrying','processing','done','infected','failed','deleting','deleted')`,
    ),
  ],
);
export const scanAttempts = sqliteTable(
  'scan_attempts',
  {
    id: text().primaryKey(),
    file_id: text()
      .notNull()
      .references(() => files.id),
    upload_generation: text().notNull(),
    attempt_number: integer().notNull(),
    claim_token: text().notNull(),
    provider: text().notNull(),
    result: text().notNull(),
    duration_ms: integer(),
    provider_response: text(),
    error_code: text(),
    error_details: text(),
    started_at: integer().notNull(),
    finished_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    uniqueIndex('attempt_number').on(t.file_id, t.attempt_number),
    check('attempt_range', sql`${t.attempt_number} BETWEEN 1 AND 3`),
    check(
      'attempt_result',
      sql`${t.result} IN ('started','clean','infected','error','interrupted')`,
    ),
  ],
);
export type StoredFile = typeof files.$inferSelect;
export type StoredUser = typeof users.$inferSelect;
export type StoredFolder = typeof folders.$inferSelect;
