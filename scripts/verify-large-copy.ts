import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { cloudflare, loadEnvironment } from './cloudflare-api';
import { PART_SIZE } from '../packages/shared/src/contracts';
import { mkdir, writeFile } from 'node:fs/promises';
loadEnvironment();
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const bucket = process.env.QUARANTINE_BUCKET!,
  clean = process.env.CLEAN_BUCKET!,
  prefix = `verification/${crypto.randomUUID()}`,
  seed = `${prefix}/seed`,
  source = `${prefix}/large`,
  target = `${prefix}/clean`,
  size = 3_000_000_000;
let uploadId: string | undefined;
let seedSource = `${bucket}/${seed}`;
try {
  // These are only interrupted probes from this project's isolated verification
  // namespace, never application uploads (which use the uploads/ prefix).
  const interrupted = await s3.send(
    new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: 'verification/' }),
  );
  for (const old of interrupted.Uploads ?? [])
    if (/^verification\/[0-9a-f-]{36}\/large$/.test(old.Key ?? ''))
      await s3.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: old.Key, UploadId: old.UploadId }),
      );
  const existing = await cloudflare<{ results: { clean_key: string }[] }[]>(
    `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${process.env.D1_DATABASE_ID}/query`,
    'POST',
    {
      sql: "SELECT f.clean_key FROM files f JOIN users u ON u.id=f.user_id WHERE u.email LIKE 'verification-%@test.invalid' AND f.status='done' AND f.actual_size>=16777216 AND f.clean_key IS NOT NULL AND f.delete_requested_at IS NULL ORDER BY f.created_at DESC LIMIT 1",
    },
  );
  if (existing[0].results.length) seedSource = `${clean}/${existing[0].results[0].clean_key}`;
  else {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: seed, IfNoneMatch: '*' }),
      { expiresIn: 600, unhoistableHeaders: new Set(['if-none-match']) },
    );
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'If-None-Match': '*' },
      body: Buffer.alloc(PART_SIZE),
    });
    if (!put.ok) throw new Error(`Seed upload failed (${put.status}).`);
  }
  console.log('Seed uploaded. Assembling the 3 GB verification object inside R2.');
  uploadId = (await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: source })))
    .UploadId!;
  const parts: { PartNumber: number; ETag: string }[] = [];
  let next = 1;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next <= Math.ceil(size / PART_SIZE)) {
        const n = next++,
          length = Math.min(PART_SIZE, size - (n - 1) * PART_SIZE);
        const copied = await s3.send(
          new UploadPartCopyCommand({
            Bucket: bucket,
            Key: source,
            UploadId: uploadId,
            PartNumber: n,
            CopySource: seedSource,
            CopySourceRange: `bytes=0-${length - 1}`,
          }),
        );
        parts.push({ PartNumber: n, ETag: copied.CopyPartResult!.ETag! });
      }
    }),
  );
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: source,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
    }),
  );
  uploadId = undefined;
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: source }));
  if (head.ContentLength !== size) throw new Error('Source size did not verify at 3 GB.');
  const started = Date.now();
  await s3.send(
    new CopyObjectCommand({
      Bucket: clean,
      Key: target,
      CopySource: `${bucket}/${source}`,
      CopySourceIfMatch: head.ETag,
      MetadataDirective: 'REPLACE',
      Metadata: { 'source-etag': head.ETag!.replaceAll('"', '') },
    }),
  );
  const destination = await s3.send(new HeadObjectCommand({ Bucket: clean, Key: target }));
  if (
    destination.ContentLength !== size ||
    destination.Metadata?.['source-etag'] !== head.ETag!.replaceAll('"', '')
  )
    throw new Error('Conditional 3 GB destination verification failed.');
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/real-r2-large-copy.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        bytes: size,
        assembly: 'R2 UploadPartCopy from an immutable verification seed',
        copy: 'Cross-bucket CopyObject with source ETag condition',
        durationMs: Date.now() - started,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(
    `Real R2 conditional cross-bucket 3 GB copy verified in ${Date.now() - started} ms. No whole-file buffering or 3 GB client retransmission.`,
  );
} finally {
  if (uploadId)
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: source, UploadId: uploadId }))
      .catch(() => {});
  await Promise.all(
    [
      [bucket, seed],
      [bucket, source],
      [clean, target],
    ].map(([Bucket, Key]) => s3.send(new DeleteObjectCommand({ Bucket, Key }))),
  );
}
