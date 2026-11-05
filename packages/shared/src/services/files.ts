import { and, eq, gt, isNull, asc, sql } from 'drizzle-orm';
import { MAX_FILE_SIZE, PART_SIZE, MULTIPART_THRESHOLD, type UploadInfo } from '../contracts';
import { database, first, all, run } from '../db/client';
import { files, type StoredFile } from '../db/schema';
import { nameKey, validateFilePath, validateName } from '../paths';
import { resolvePath } from './folders';
import { listParts, uploadUrl, URL_LIFETIME } from './r2';
import { AppError, type ServiceBindings } from './types';

export const getFile = (env: ServiceBindings, id: string) =>
  first<StoredFile>(env.DB, 'SELECT * FROM files WHERE id=?', id);
export async function ownedFile(
  env: ServiceBindings,
  userId: string,
  id: string,
  allowDeleting = false,
) {
  const file = await getFile(env, id);
  if (
    !file ||
    file.user_id !== userId ||
    (!allowDeleting && (file.delete_requested_at || file.deleted_at))
  )
    throw new AppError(404, 'File not found.');
  return file;
}
export function fileDto(f: StoredFile & { email?: string }) {
  const {
    id,
    user_id,
    folder_id,
    filename,
    mime_type,
    expected_size,
    actual_size,
    status,
    stage,
    scan_attempt_count,
    block_reason,
    last_error,
    created_at,
    updated_at,
    processing_started_at,
    last_processed_at,
    lease_expires_at,
    delete_requested_at,
    deleted_at,
    email,
  } = f;
  return {
    id,
    user_id,
    folder_id,
    filename,
    mime_type,
    expected_size,
    actual_size,
    status,
    stage,
    scan_attempt_count,
    block_reason,
    last_error,
    created_at,
    updated_at,
    processing_started_at,
    last_processed_at,
    lease_expires_at,
    delete_requested_at,
    deleted_at,
    email,
  };
}
export async function uploadInfo(env: ServiceBindings, file: StoredFile): Promise<UploadInfo> {
  if (
    !['pending', 'uploading'].includes(file.status) ||
    file.delete_requested_at ||
    file.upload_expires_at <= Date.now()
  )
    throw new AppError(409, 'This upload session is no longer active.');
  const expiresAt = Date.now() + URL_LIFETIME;
  await run(
    env.DB,
    'UPDATE files SET latest_signed_url_expires_at=MAX(latest_signed_url_expires_at,?) WHERE id=? AND upload_generation=? AND delete_requested_at IS NULL',
    expiresAt,
    file.id,
    file.upload_generation,
  );
  const put = file.upload_kind === 'single' ? await uploadUrl(env, file) : {};
  return {
    id: file.id,
    generation: file.upload_generation,
    kind: file.upload_kind,
    partSize: PART_SIZE,
    expiresAt,
    ...put,
  };
}
export async function startUpload(
  env: ServiceBindings,
  userId: string,
  input: {
    filename: string;
    size: number;
    mimeType: string;
    folderPath: string;
    clientUploadId: string;
    retryFileId?: string;
  },
) {
  const filename = validateName(input.filename);
  validateFilePath(input.folderPath, filename);
  const folderId = await resolvePath(env, userId, input.folderPath, true);
  const id = input.retryFileId ?? input.clientUploadId;
  let existing = await getFile(env, id);
  if (existing && existing.user_id !== userId)
    throw new AppError(409, 'Upload identifier is already in use.');
  if (existing && !input.retryFileId) {
    if (
      existing.filename !== filename ||
      existing.expected_size !== input.size ||
      existing.folder_id !== folderId ||
      existing.mime_type !== input.mimeType
    )
      throw new AppError(409, 'An upload identifier cannot be reused with different metadata.');
    if (
      existing.upload_kind === 'multipart' &&
      !existing.multipart_upload_id &&
      ['pending', 'uploading'].includes(existing.status)
    )
      await ensureMultipart(env, existing);
    return uploadInfo(env, (await getFile(env, existing.id))!);
  }
  if (
    input.retryFileId &&
    (!existing ||
      existing.status !== 'failed' ||
      existing.scan_verdict ||
      existing.scan_attempt_count >= 3 ||
      existing.delete_requested_at)
  )
    throw new AppError(409, 'Only failed transfers can start another upload session.');
  const now = Date.now(),
    generation = crypto.randomUUID(),
    kind = input.size < MULTIPART_THRESHOLD ? 'single' : 'multipart';
  const key = `uploads/${userId}/${id}/${generation}`;
  if (existing?.multipart_upload_id) {
    try {
      await env.QUARANTINE.resumeMultipartUpload(
        existing.quarantine_key,
        existing.multipart_upload_id,
      ).abort();
    } catch {
      /* Aborted/complete is already safe; old generation events cannot publish. */
    }
  }
  if (existing) await env.QUARANTINE.delete(existing.quarantine_key);
  try {
    if (existing) {
      const changed = await run(
        env.DB,
        `UPDATE files SET upload_generation=?,quarantine_key=?,multipart_upload_id=NULL,upload_kind=?,status='pending',stage='verify',source_etag=NULL,actual_size=NULL,last_error=NULL,last_error_code=NULL,claim_token=NULL,lease_expires_at=NULL,upload_expires_at=?,latest_signed_url_expires_at=?,updated_at=? WHERE id=? AND user_id=? AND status='failed' AND delete_requested_at IS NULL`,
        generation,
        key,
        kind,
        now + 86_400_000,
        now + URL_LIFETIME,
        now,
        id,
        userId,
      );
      if (!changed.meta.changes) throw new AppError(409, 'Upload changed. Refresh and try again.');
    } else {
      await run(
        env.DB,
        `INSERT INTO files(id,user_id,folder_id,filename,filename_key,mime_type,expected_size,upload_generation,upload_kind,quarantine_key,upload_expires_at,latest_signed_url_expires_at,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM folders WHERE id=? AND user_id=? AND delete_requested_at IS NULL AND deleted_at IS NULL)`,
        id,
        userId,
        folderId,
        filename,
        nameKey(filename),
        input.mimeType,
        input.size,
        generation,
        kind,
        key,
        now + 86_400_000,
        now + URL_LIFETIME,
        now,
        now,
        folderId,
        folderId,
        userId,
      );
    }
  } catch (e) {
    if (String(e).includes('UNIQUE'))
      throw new AppError(
        409,
        'A file with this name already exists in this folder. Delete it before reusing its name.',
      );
    throw e;
  }
  const file = await ownedFile(env, userId, id);
  if (kind === 'multipart') {
    await ensureMultipart(env, file);
  }
  await run(
    env.DB,
    "UPDATE files SET status='uploading',updated_at=? WHERE id=? AND status='pending' AND delete_requested_at IS NULL",
    now,
    id,
  );
  return uploadInfo(env, (await getFile(env, id))!);
}
async function ensureMultipart(env: ServiceBindings, file: StoredFile) {
  const multipart = await env.QUARANTINE.createMultipartUpload(file.quarantine_key, {
    httpMetadata: { contentType: file.mime_type },
    customMetadata: { 'file-id': file.id, generation: file.upload_generation },
  });
  try {
    const result = await run(
      env.DB,
      "UPDATE files SET multipart_upload_id=?,status='uploading' WHERE id=? AND upload_generation=? AND delete_requested_at IS NULL AND multipart_upload_id IS NULL AND status IN ('pending','uploading')",
      multipart.uploadId,
      file.id,
      file.upload_generation,
    );
    if (!result.meta.changes) {
      await multipart.abort();
      const current = await getFile(env, file.id);
      if (!current?.multipart_upload_id || current.delete_requested_at)
        throw new AppError(409, 'Upload was cancelled.');
    }
  } catch (error) {
    await multipart.abort().catch(() => {});
    throw error;
  }
}
export async function signParts(
  env: ServiceBindings,
  userId: string,
  id: string,
  generation: string,
  parts: number[],
) {
  const file = await ownedFile(env, userId, id);
  await uploadInfo(env, file);
  if (
    file.upload_generation !== generation ||
    file.upload_kind !== 'multipart' ||
    !file.multipart_upload_id
  )
    throw new AppError(409, 'Invalid multipart session.');
  const maxPart = Math.ceil(file.expected_size / PART_SIZE);
  if (
    !parts.length ||
    parts.length > 16 ||
    parts.some((p) => !Number.isInteger(p) || p < 1 || p > maxPart)
  )
    throw new AppError(422, 'Invalid part numbers.');
  return Promise.all(
    parts.map(async (partNumber) => ({ partNumber, ...(await uploadUrl(env, file, partNumber)) })),
  );
}
export async function completeUpload(
  env: ServiceBindings,
  userId: string,
  id: string,
  generation: string,
  manifest?: { partNumber: number; etag: string }[],
) {
  let file = await ownedFile(env, userId, id);
  if (file.upload_generation !== generation)
    throw new AppError(409, 'This upload session was replaced.');
  if (!['pending', 'uploading'].includes(file.status)) return fileDto(file);
  let object = await env.QUARANTINE.head(file.quarantine_key);
  if (!object && file.upload_kind === 'multipart') {
    if (!manifest?.length || !file.multipart_upload_id)
      throw new AppError(422, 'Completed parts are required.');
    const actual = (await listParts(env, file)).sort((a, b) => a.partNumber - b.partNumber);
    const ordered = [...manifest].sort((a, b) => a.partNumber - b.partNumber);
    const normalized = (s: string) => s.replaceAll('"', '');
    if (
      ordered.length !== Math.ceil(file.expected_size / PART_SIZE) ||
      actual.length !== ordered.length ||
      actual.some(
        (p, i) =>
          p.partNumber !== i + 1 ||
          p.partNumber !== ordered[i].partNumber ||
          normalized(p.etag) !== normalized(ordered[i].etag) ||
          p.size !== Math.min(PART_SIZE, file.expected_size - i * PART_SIZE),
      )
    )
      throw new AppError(
        422,
        'Parts do not match the expected file. Reconcile the upload and try again.',
      );
    try {
      await env.QUARANTINE.resumeMultipartUpload(
        file.quarantine_key,
        file.multipart_upload_id,
      ).complete(actual.map((p) => ({ partNumber: p.partNumber, etag: normalized(p.etag) })));
    } catch (e) {
      if (!(await env.QUARANTINE.head(file.quarantine_key))) throw e;
    }
    object = await env.QUARANTINE.head(file.quarantine_key);
  }
  if (!object) throw new AppError(409, 'The object has not arrived yet. Retry completion.');
  if (object.size !== file.expected_size || object.size > MAX_FILE_SIZE) {
    await run(
      env.DB,
      "UPDATE files SET status='failed',last_error='Uploaded size does not match the declared file size.',updated_at=? WHERE id=? AND delete_requested_at IS NULL",
      Date.now(),
      id,
    );
    throw new AppError(422, 'Uploaded size does not match the declared file size.');
  }
  await run(
    env.DB,
    "UPDATE files SET actual_size=?,source_etag=?,upload_completed_at=?,updated_at=? WHERE id=? AND upload_generation=? AND status IN ('pending','uploading') AND delete_requested_at IS NULL",
    object.size,
    object.etag,
    Date.now(),
    Date.now(),
    id,
    generation,
  );
  // Native R2 events are the production trigger. An explicit duplicate is safe and
  // repairs a lost event; local emulation also uses this path.
  await env.JOBS.send({ type: 'process', fileId: id, generation });
  file = (await getFile(env, id))!;
  return fileDto(file);
}
export async function requestDelete(env: ServiceBindings, userId: string, id: string) {
  const f = await ownedFile(env, userId, id, true);
  if (f.deleted_at) return;
  const now = Date.now();
  await run(
    env.DB,
    `UPDATE files SET delete_requested_at=COALESCE(delete_requested_at,?),status='deleting',stage='cleanup',cleanup_after=MAX(cleanup_after,latest_signed_url_expires_at,COALESCE(lease_expires_at,0)),claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NULL`,
    now,
    now,
    id,
  );
  await env.JOBS.send({ type: 'cleanup', fileId: id });
}
export async function requestFolderDelete(env: ServiceBindings, userId: string, id: string) {
  const folder = await first(
    env.DB,
    'SELECT id FROM folders WHERE id=? AND user_id=? AND deleted_at IS NULL',
    id,
    userId,
  );
  if (!folder) throw new AppError(404, 'Folder not found.');
  const subtree = `WITH RECURSIVE subtree(id) AS (SELECT id FROM folders WHERE id=? AND user_id=? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) `;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `${subtree} UPDATE folders SET delete_requested_at=COALESCE(delete_requested_at,?),updated_at=? WHERE id IN (SELECT id FROM subtree)`,
    ).bind(id, userId, now, now),
    env.DB.prepare(
      `${subtree} UPDATE files SET delete_requested_at=COALESCE(delete_requested_at,?),status='deleting',stage='cleanup',cleanup_after=MAX(cleanup_after,latest_signed_url_expires_at,COALESCE(lease_expires_at,0)),claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE folder_id IN (SELECT id FROM subtree) AND deleted_at IS NULL`,
    ).bind(id, userId, now, now),
  ]);
  await env.JOBS.send({ type: 'folder-cleanup', fileId: id });
}
export async function listUserFiles(
  env: ServiceBindings,
  userId: string,
  path?: string,
  ids?: string[],
  cursor?: string,
) {
  if (ids) {
    if (ids.length > 100) throw new AppError(422, 'At most 100 files can be polled at once.');
    return (
      await all<StoredFile>(
        env.DB,
        `SELECT * FROM files WHERE user_id=? AND id IN (${ids.map(() => '?').join(',') || "''"})`,
        userId,
        ...ids,
      )
    ).map(fileDto);
  }
  const folder = path === undefined ? undefined : await resolvePath(env, userId, path);
  const rows = await database(env.DB)
    .select()
    .from(files)
    .where(
      and(
        eq(files.user_id, userId),
        isNull(files.deleted_at),
        isNull(files.delete_requested_at),
        sql`${files.upload_completed_at} IS NOT NULL`,
        ...(folder === undefined
          ? []
          : [folder === null ? isNull(files.folder_id) : eq(files.folder_id, folder)]),
        ...(cursor ? [gt(files.id, cursor)] : []),
      ),
    )
    .orderBy(asc(files.id))
    .limit(201);
  return rows.map(fileDto);
}
