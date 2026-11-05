import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnvironment, requireVariables } from './cloudflare-api';
import { PART_SIZE } from '../packages/shared/src/contracts';
loadEnvironment();
requireVariables(
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'QUARANTINE_BUCKET',
  'CLEAN_BUCKET',
);
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const quarantine = process.env.QUARANTINE_BUCKET!,
  clean = process.env.CLEAN_BUCKET!,
  prefix = `verification/${crypto.randomUUID()}`,
  key = `${prefix}/single`,
  copiedKey = `${prefix}/copied`,
  largeKey = `${prefix}/large`;
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
let multipartId: string | undefined;
try {
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: quarantine,
      Key: key,
      IfNoneMatch: '*',
      Metadata: { verification: prefix },
    }),
    { expiresIn: 300, unhoistableHeaders: new Set(['if-none-match']) },
  );
  assert(
    new URL(url).searchParams.get('X-Amz-SignedHeaders')?.includes('if-none-match'),
    'The create-once header must be signed.',
  );
  const first = await fetch(url, {
    method: 'PUT',
    headers: { 'If-None-Match': '*' },
    body: 'File Vault R2 verification',
  });
  assert(first.ok, `Presigned PUT failed: ${first.status}`);
  const duplicate = await fetch(url, {
    method: 'PUT',
    headers: { 'If-None-Match': '*' },
    body: 'overwrite attempt',
  });
  assert(duplicate.status === 412, `Expected replay rejection, received ${duplicate.status}.`);
  const missingHeader = await fetch(url, { method: 'PUT', body: 'unsigned condition attempt' });
  assert(missingHeader.status === 403, 'Removing the signed condition must invalidate the URL.');
  const head = await s3.send(new HeadObjectCommand({ Bucket: quarantine, Key: key }));
  let rejected = false;
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: clean,
        Key: copiedKey,
        CopySource: `${quarantine}/${key}`,
        CopySourceIfMatch: '"wrong-etag"',
      }),
    );
  } catch {
    rejected = true;
  }
  assert(rejected, 'Copying a mismatched source must fail.');
  await s3.send(
    new CopyObjectCommand({
      Bucket: clean,
      Key: copiedKey,
      CopySource: `${quarantine}/${key}`,
      CopySourceIfMatch: head.ETag,
    }),
  );
  assert(
    (await s3.send(new HeadObjectCommand({ Bucket: clean, Key: copiedKey }))).ContentLength ===
      head.ContentLength,
    'Copied object length mismatch.',
  );
  if (process.env.APP_ORIGIN) {
    const cors = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: process.env.APP_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'if-none-match',
      },
    });
    assert(
      cors.headers.get('access-control-allow-origin') === process.env.APP_ORIGIN,
      'R2 CORS preflight did not authorize the application origin.',
    );
  }
  console.log(
    'R2 presigning, signed-condition enforcement, overwrite prevention, conditional copy and CORS passed.',
  );
  if (process.argv.includes('--large')) {
    const started = Date.now(),
      size = 3_000_000_000,
      content = Buffer.alloc(PART_SIZE),
      manifest: { PartNumber: number; ETag: string }[] = [];
    multipartId = (
      await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: quarantine,
          Key: largeKey,
          Metadata: { verification: prefix },
        }),
      )
    ).UploadId!;
    let next = 1,
      reported = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next <= Math.ceil(size / PART_SIZE)) {
          const part = next++,
            length = Math.min(PART_SIZE, size - (part - 1) * PART_SIZE);
          const partUrl = await getSignedUrl(
            s3,
            new UploadPartCommand({
              Bucket: quarantine,
              Key: largeKey,
              UploadId: multipartId,
              PartNumber: part,
            }),
            { expiresIn: 600 },
          );
          let etag = '';
          for (let attempt = 0; attempt <= 5; attempt++) {
            try {
              const response = await fetch(partUrl, {
                method: 'PUT',
                body: content.subarray(0, length),
              });
              if (!response.ok) throw new Error(`R2 part returned ${response.status}`);
              etag = response.headers.get('etag')!;
              break;
            } catch (error) {
              if (attempt === 5) throw error;
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
          manifest.push({ PartNumber: part, ETag: etag });
          const percentage = Math.floor((manifest.length / Math.ceil(size / PART_SIZE)) * 100);
          if (percentage >= reported + 10) {
            reported = percentage;
            console.log(`Real R2 3 GB upload: ${percentage}%`);
          }
        }
      }),
    );
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: quarantine,
        Key: largeKey,
        UploadId: multipartId,
        MultipartUpload: { Parts: manifest.sort((a, b) => a.PartNumber - b.PartNumber) },
      }),
    );
    multipartId = undefined;
    const source = await s3.send(new HeadObjectCommand({ Bucket: quarantine, Key: largeKey }));
    assert(source.ContentLength === size, 'R2 did not store all 3 GB.');
    await s3.send(
      new CopyObjectCommand({
        Bucket: clean,
        Key: copiedKey,
        CopySource: `${quarantine}/${largeKey}`,
        CopySourceIfMatch: source.ETag,
        MetadataDirective: 'REPLACE',
        Metadata: { 'source-etag': source.ETag!.replaceAll('"', '') },
      }),
    );
    const target = await s3.send(new HeadObjectCommand({ Bucket: clean, Key: copiedKey }));
    assert(target.ContentLength === size, '3 GB conditional copy failed verification.');
    console.log(
      `Real R2 3 GB multipart upload and conditional cross-bucket copy passed in ${Math.ceil((Date.now() - started) / 1000)}s.`,
    );
  }
} finally {
  if (multipartId)
    await s3
      .send(
        new AbortMultipartUploadCommand({
          Bucket: quarantine,
          Key: largeKey,
          UploadId: multipartId,
        }),
      )
      .catch(() => {});
  await Promise.all(
    [
      [quarantine, key],
      [quarantine, largeKey],
      [clean, copiedKey],
    ].map(([Bucket, Key]) => s3.send(new DeleteObjectCommand({ Bucket, Key }))),
  );
}
