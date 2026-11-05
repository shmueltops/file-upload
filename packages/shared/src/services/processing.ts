import { first, all, run } from '../db/client';
import { MAX_FILE_SIZE, type WorkMessage, type R2Event } from '../contracts';
import type { StoredFile } from '../db/schema';
import { getFile } from './files';
import { copyToClean, deletePrefix } from './r2';
import { scanFile } from './scanner';
import { AppError, RetryWork, type ServiceBindings } from './types';

const LEASE_MS = 16 * 60_000;
export async function cleanupFile(env: ServiceBindings, id: string) {
  const file = await getFile(env, id);
  if (!file) return;
  if (!file.delete_requested_at) {
    if (file.status === 'done' || file.status === 'infected') {
      await env.QUARANTINE.delete(file.quarantine_key);
      await deletePrefix(env.QUARANTINE, `parts/${id}/`);
    }
    return;
  }
  if (file.multipart_upload_id) {
    try {
      await env.QUARANTINE.resumeMultipartUpload(
        file.quarantine_key,
        file.multipart_upload_id,
      ).abort();
    } catch (error) {
      if (!/NoSuchUpload|not exist|already|completed|aborted/i.test(String(error))) throw error;
    }
  }
  const prefix = `uploads/${file.user_id}/${file.id}/`;
  await deletePrefix(env.QUARANTINE, prefix);
  await deletePrefix(env.CLEAN, prefix);
  await deletePrefix(env.QUARANTINE, `parts/${id}/`);
  if (Date.now() < file.cleanup_after)
    throw new RetryWork(
      Math.min(1000, Math.max(1, Math.ceil((file.cleanup_after - Date.now()) / 1000))),
      'Waiting for issued upload URLs and processing writers to expire.',
    );
  await run(
    env.DB,
    "UPDATE files SET status='deleted',deleted_at=COALESCE(deleted_at,?),updated_at=?,last_error=NULL WHERE id=? AND delete_requested_at IS NOT NULL",
    Date.now(),
    Date.now(),
    id,
  );
  await run(
    env.DB,
    `UPDATE folders SET deleted_at=?,updated_at=? WHERE delete_requested_at IS NOT NULL AND deleted_at IS NULL AND NOT EXISTS(
    WITH RECURSIVE subtree(id) AS (SELECT folders.id UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id)
    SELECT 1 FROM files WHERE folder_id IN (SELECT id FROM subtree) AND deleted_at IS NULL)`,
    Date.now(),
    Date.now(),
  );
}
async function cleanupFolder(env: ServiceBindings, id: string) {
  const remaining = await all<{ id: string }>(
    env.DB,
    `WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) SELECT id FROM files WHERE folder_id IN (SELECT id FROM subtree) AND delete_requested_at IS NOT NULL AND deleted_at IS NULL LIMIT 100`,
    id,
  );
  if (remaining.length) {
    await env.JOBS.sendBatch(remaining.map((f) => ({ body: { type: 'cleanup', fileId: f.id } })));
    throw new RetryWork(60, 'Waiting for recursive file cleanup.');
  }
  await run(
    env.DB,
    `WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN subtree s ON f.parent_id=s.id) UPDATE folders SET deleted_at=?,updated_at=? WHERE id IN (SELECT id FROM subtree) AND delete_requested_at IS NOT NULL`,
    id,
    Date.now(),
    Date.now(),
  );
}
export async function processFile(
  env: ServiceBindings,
  id: string,
  generation?: string,
  random?: () => number,
) {
  let file = await getFile(env, id);
  if (!file) return;
  if (generation && file.upload_generation !== generation) {
    await env.QUARANTINE.delete(`uploads/${file.user_id}/${id}/${generation}`);
    return;
  }
  if (file.delete_requested_at) return cleanupFile(env, id);
  if (file.status === 'done' || file.status === 'infected') return cleanupFile(env, id);
  if (file.status === 'failed') return;
  const now = Date.now(),
    token = crypto.randomUUID();
  const claimed = await first<StoredFile>(
    env.DB,
    `UPDATE files SET claim_token=?,lease_expires_at=?,processing_started_at=COALESCE(processing_started_at,?),last_processed_at=?,updated_at=?
    WHERE id=? AND upload_generation=? AND delete_requested_at IS NULL AND deleted_at IS NULL AND status NOT IN ('done','infected','failed','deleted','deleting') AND (lease_expires_at IS NULL OR lease_expires_at<?) RETURNING *`,
    token,
    now + LEASE_MS,
    now,
    now,
    now,
    id,
    file.upload_generation,
    now,
  );
  if (!claimed)
    throw new RetryWork(
      Math.max(1, Math.ceil(((file.lease_expires_at ?? now + 10_000) - now) / 1000)),
      'Another consumer holds the processing lease.',
    );
  file = claimed;
  const update = async (sql: string, ...values: unknown[]) => {
    const result = await run(
      env.DB,
      `UPDATE files SET ${sql},updated_at=?,last_processed_at=? WHERE id=? AND claim_token=? AND upload_generation=? AND delete_requested_at IS NULL`,
      ...values,
      Date.now(),
      Date.now(),
      id,
      token,
      file!.upload_generation,
    );
    if (!result.meta.changes)
      throw new AppError(409, 'Processing claim was revoked.', 'claim_revoked');
  };
  try {
    const object = await env.QUARANTINE.head(file.quarantine_key);
    if (!object) throw new Error('Quarantine object is not available yet.');
    if (
      object.size !== file.expected_size ||
      object.size > MAX_FILE_SIZE ||
      object.customMetadata?.generation !== file.upload_generation ||
      object.customMetadata?.['file-id'] !== id ||
      (file.source_etag && file.source_etag !== object.etag)
    ) {
      await update(
        "status='failed',last_error_code='object_mismatch',last_error='Uploaded object does not match the registered upload.',claim_token=NULL,lease_expires_at=NULL",
      );
      return;
    }
    await update(
      'actual_size=?,source_etag=?,upload_completed_at=COALESCE(upload_completed_at,?)',
      object.size,
      object.etag,
      Date.now(),
    );
    if (!file.scan_verdict) {
      await run(
        env.DB,
        "UPDATE scan_attempts SET result='interrupted',error_details='Previous consumer stopped before recording a result.',finished_at=?,updated_at=? WHERE file_id=? AND result='started' AND claim_token<>?",
        Date.now(),
        Date.now(),
        id,
        token,
      );
      if (file.scan_attempt_count >= 3) {
        await update(
          "status='failed',last_error_code='scan_exhausted',last_error='Three scan attempts were exhausted.',claim_token=NULL,lease_expires_at=NULL",
        );
        return;
      }
      const attemptId = crypto.randomUUID(),
        started = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE files SET scan_attempt_count=scan_attempt_count+1,status='scanning',stage='scan' WHERE id=? AND claim_token=? AND delete_requested_at IS NULL AND scan_attempt_count<3",
        ).bind(id, token),
        env.DB.prepare(
          `INSERT INTO scan_attempts(id,file_id,upload_generation,attempt_number,claim_token,provider,result,started_at,created_at,updated_at)
          SELECT ?,id,upload_generation,scan_attempt_count,?,'fake-scanner-v1','started',?,?,? FROM files WHERE id=? AND claim_token=? AND delete_requested_at IS NULL`,
        ).bind(attemptId, token, started, started, started, id, token),
      ]);
      const reserved = await first<{ id: string }>(
        env.DB,
        'SELECT id FROM scan_attempts WHERE id=?',
        attemptId,
      );
      if (!reserved) throw new AppError(409, 'Processing claim was revoked.', 'claim_revoked');
      const verdict = await scanFile(file.filename, random);
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE scan_attempts SET result=?,duration_ms=?,provider_response=?,finished_at=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND claim_token=? AND delete_requested_at IS NULL)`,
        ).bind(
          verdict.result,
          Date.now() - started,
          JSON.stringify(verdict),
          Date.now(),
          Date.now(),
          attemptId,
          id,
          token,
        ),
        env.DB.prepare(
          `UPDATE files SET scan_verdict=?,approved_source_etag=?,block_reason=?,status=?,stage=?,updated_at=?,last_processed_at=? WHERE id=? AND claim_token=? AND delete_requested_at IS NULL`,
        ).bind(
          verdict.result,
          object.etag,
          verdict.reason,
          verdict.result === 'infected' ? 'infected' : 'processing',
          verdict.result === 'infected' ? 'cleanup' : 'promote',
          Date.now(),
          Date.now(),
          id,
          token,
        ),
      ]);
      file = (await getFile(env, id))!;
      if (file.claim_token !== token || file.delete_requested_at)
        throw new AppError(409, 'Processing claim was revoked.', 'claim_revoked');
      if (verdict.result === 'infected') {
        await update('claim_token=NULL,lease_expires_at=NULL');
        await cleanupFile(env, id);
        return;
      }
    }
    file = (await getFile(env, id))!;
    await update("status='processing',stage='promote'");
    const destination = `${file.quarantine_key}/clean-${token}`;
    const copied = await copyToClean(env, file, destination);
    try {
      await update(
        "clean_key=?,clean_etag=?,status='done',stage='cleanup',completed_at=?,last_error=NULL,last_error_code=NULL,claim_token=NULL,lease_expires_at=NULL",
        destination,
        copied.etag,
        Date.now(),
      );
    } catch (e) {
      await env.CLEAN.delete(destination);
      throw e;
    }
    await cleanupFile(env, id);
    await run(env.DB, "UPDATE files SET stage='complete' WHERE id=? AND status='done'", id);
  } catch (e) {
    if (e instanceof AppError && e.code === 'claim_revoked') return;
    const message = e instanceof Error ? e.message.slice(0, 1000) : 'Processing failed';
    const current = await getFile(env, id);
    if (current?.delete_requested_at) {
      await env.JOBS.send({ type: 'cleanup', fileId: id });
      return;
    }
    if (current?.status === 'done' || current?.status === 'infected') {
      await env.JOBS.send({ type: 'cleanup', fileId: id });
      return;
    }
    await run(
      env.DB,
      "UPDATE scan_attempts SET result='error',error_details=?,finished_at=?,updated_at=? WHERE file_id=? AND claim_token=? AND result='started'",
      message,
      Date.now(),
      Date.now(),
      id,
      token,
    );
    const exhausted = current && !current.scan_verdict && current.scan_attempt_count >= 3;
    await update(
      "status=?,last_error=?,last_error_code='operational_failure',claim_token=NULL,lease_expires_at=NULL",
      exhausted ? 'failed' : 'retrying',
      message,
    );
    if (!exhausted) throw new RetryWork(10, message);
  }
}
export async function handleWork(env: ServiceBindings, body: WorkMessage | R2Event) {
  if ('action' in body) {
    const parts = body.object?.key?.split('/') ?? [];
    if (body.bucket !== env.QUARANTINE_BUCKET || parts.length !== 4 || parts[0] !== 'uploads')
      return;
    return processFile(env, parts[2], parts[3]);
  }
  if (body.type === 'folder-cleanup') return cleanupFolder(env, body.fileId);
  if (body.type === 'cleanup') return cleanupFile(env, body.fileId);
  if (body.type === 'process') return processFile(env, body.fileId, body.generation);
  throw new Error('Unknown queue message type.');
}
