import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { cloudflare, loadEnvironment } from './cloudflare-api';
loadEnvironment();
const r = await cloudflare<
  {
    results: {
      id: string;
      quarantine_key: string;
      expected_size: number;
      source_etag: string | null;
      upload_generation: string;
    }[];
  }[]
>(
  `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${process.env.D1_DATABASE_ID}/query`,
  'POST',
  {
    sql: 'SELECT id,quarantine_key,expected_size,source_etag,upload_generation FROM files ORDER BY created_at DESC LIMIT 8',
  },
);
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
for (const file of r[0].results) {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: process.env.QUARANTINE_BUCKET, Key: file.quarantine_key }),
    );
    console.log(
      JSON.stringify({
        id: file.id,
        metadataKeys: Object.keys(head.Metadata ?? {}),
        sizeMatches: head.ContentLength === file.expected_size,
        generationMatches: head.Metadata?.generation === file.upload_generation,
        fileIdMatches: head.Metadata?.['file-id'] === file.id,
        etagMatches:
          file.source_etag === null || file.source_etag === head.ETag?.replaceAll('"', ''),
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ id: file.id, missing: (e as { name: string }).name }));
  }
}
