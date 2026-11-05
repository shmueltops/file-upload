import { z } from 'zod';

export const MAX_FILE_SIZE = 3_000_000_000;
export const MULTIPART_THRESHOLD = 20 * 1024 * 1024;
export const PART_SIZE = 16 * 1024 * 1024;
export const PART_CONCURRENCY = 4;
export const MAX_SCAN_ATTEMPTS = 3;
export const ACTIVE_STATUSES = [
  'pending',
  'uploading',
  'scanning',
  'processing',
  'retrying',
] as const;
export const statuses = [
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
] as const;
export type FileStatus = (typeof statuses)[number];
export const uploadInput = z.object({
  filename: z.string().min(1),
  size: z.number().int().min(0).max(MAX_FILE_SIZE),
  mimeType: z.string().max(255).default('application/octet-stream'),
  folderPath: z.string(),
  clientUploadId: z.uuid(),
  retryFileId: z.uuid().optional(),
});
export const loginInput = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
});
export const passwordInput = z.string().min(12, 'Use at least 12 characters.').max(1024);
export type User = {
  id: string;
  email: string;
  role: 'user' | 'admin';
  must_change_password: boolean;
};
export type Folder = {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: number;
  delete_requested_at: number | null;
};
export type FileRecord = {
  id: string;
  user_id: string;
  folder_id: string | null;
  filename: string;
  mime_type: string;
  expected_size: number;
  actual_size: number | null;
  status: FileStatus;
  stage: string;
  scan_attempt_count: number;
  block_reason: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  processing_started_at: number | null;
  last_processed_at: number | null;
  lease_expires_at: number | null;
  delete_requested_at: number | null;
  deleted_at: number | null;
  email?: string;
  path?: string;
};
export type UploadInfo = {
  id: string;
  generation: string;
  kind: 'single' | 'multipart';
  url?: string;
  headers?: Record<string, string>;
  partSize: number;
  expiresAt: number;
};
export type WorkMessage = {
  type: 'process' | 'cleanup' | 'folder-cleanup';
  fileId: string;
  generation?: string;
};
export type R2Event = {
  bucket: string;
  action: string;
  object: { key: string; size: number; eTag: string };
};
