import { S3Client, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { cloudflare, loadEnvironment } from './cloudflare-api';

// One-time repair for uploads completed by the initial presigner version.
// Annotates only immutable, size/ETag-verified bytes; never reads file contents.
loadEnvironment();
const base = `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}`;
const db = `${base}/d1/database/${process.env.D1_DATABASE_ID}/query`;
type Candidate = {
  id: string;
  quarantine_key: string;
  expected_size: number;
  source_etag: string;
  upload_generation: string;
};
const rows = await cloudflare<{ results: Candidate[] }[]>(db, 'POST', {
  sql: "SELECT id,quarantine_key,expected_size,source_etag,upload_generation FROM files WHERE status='failed' AND last_error_code='object_mismatch' AND scan_attempt_count=0 AND scan_verdict IS NULL AND upload_completed_at IS NOT NULL AND delete_requested_at IS NULL",
});
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
const queues = await cloudflare<{ queue_name: string; queue_id: string }[]>(`${base}/queues`);
const queue = queues.find(
  (q) => q.queue_name === (process.env.PROCESSING_QUEUE || 'file-vault-processing'),
)!;
for (const file of rows[0].results) {
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: process.env.QUARANTINE_BUCKET, Key: file.quarantine_key }),
  );
  if (
    head.ContentLength !== file.expected_size ||
    head.ETag?.replaceAll('"', '') !== file.source_etag ||
    Object.keys(head.Metadata ?? {}).length
  ) {
    console.log(`Skipped ${file.id}: repair prerequisites not met.`);
    continue;
  }
  await s3.send(
    new CopyObjectCommand({
      Bucket: process.env.QUARANTINE_BUCKET,
      Key: file.quarantine_key,
      CopySource: `${process.env.QUARANTINE_BUCKET}/${file.quarantine_key}`,
      CopySourceIfMatch: head.ETag,
      MetadataDirective: 'REPLACE',
      Metadata: { 'file-id': file.id, generation: file.upload_generation },
      ContentType: head.ContentType,
    }),
  );
  const checked = await s3.send(
    new HeadObjectCommand({ Bucket: process.env.QUARANTINE_BUCKET, Key: file.quarantine_key }),
  );
  if (
    checked.ContentLength !== file.expected_size ||
    checked.Metadata?.generation !== file.upload_generation ||
    checked.Metadata?.['file-id'] !== file.id
  )
    throw new Error('Repaired metadata did not verify.');
  await cloudflare(db, 'POST', {
    sql: "UPDATE files SET status='retrying',stage='verify',source_etag=?,last_error=NULL,last_error_code=NULL,updated_at=? WHERE id=? AND status='failed' AND scan_attempt_count=0 AND delete_requested_at IS NULL",
    params: [checked.ETag!.replaceAll('"', ''), Date.now(), file.id],
  });
  await cloudflare(`${base}/queues/${queue.queue_id}/messages`, 'POST', {
    content_type: 'json',
    body: { type: 'process', fileId: file.id, generation: file.upload_generation },
  });
  console.log(`Verified metadata and requeued ${file.id}.`);
}
