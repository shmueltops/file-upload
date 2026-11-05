import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './build';
import { loadEnvironment, requireVariables, cloudflare } from './cloudflare-api';
loadEnvironment();
requireVariables('CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN');
const account = process.env.CLOUDFLARE_ACCOUNT_ID!;
const base = `/accounts/${account}`;
const names = {
  quarantine: process.env.QUARANTINE_BUCKET || 'file-vault-quarantine',
  clean: process.env.CLEAN_BUCKET || 'file-vault-clean',
  jobs: process.env.PROCESSING_QUEUE || 'file-vault-processing',
  dlq: process.env.DEAD_LETTER_QUEUE || 'file-vault-dead-letter',
};
const databaseName = process.env.D1_DATABASE_NAME || 'file-vault';
const databases = await cloudflare<{ uuid: string; name: string }[]>(
  `${base}/d1/database?name=${encodeURIComponent(databaseName)}`,
);
let database = databases.find((d) => d.name === databaseName);
if (!process.env.D1_DATABASE_ID && !database)
  database = await cloudflare(`${base}/d1/database`, 'POST', {
    name: databaseName,
    primary_location_hint: 'enam',
    read_replication: { mode: 'disabled' },
  });
const databaseId = process.env.D1_DATABASE_ID || database!.uuid;
const existingBuckets = await cloudflare<{ buckets: { name: string }[] }>(`${base}/r2/buckets`);
for (const bucket of [names.quarantine, names.clean]) {
  if (!existingBuckets.buckets.some((b) => b.name === bucket))
    await cloudflare(`${base}/r2/buckets`, 'POST', { name: bucket, locationHint: 'enam' });
  await cloudflare(`${base}/r2/buckets/${bucket}/lifecycle`, 'PUT', {
    rules: [
      {
        id: 'Abort incomplete uploads after one day',
        enabled: true,
        conditions: { prefix: '' },
        abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86400 } },
      },
    ],
  });
}
const queues = await cloudflare<{ queue_name: string; queue_id: string }[]>(`${base}/queues`);
for (const name of [names.jobs, names.dlq])
  if (!queues.some((q) => q.queue_name === name))
    queues.push(await cloudflare(`${base}/queues`, 'POST', { queue_name: name }));
const queueId = queues.find((q) => q.queue_name === names.jobs)!.queue_id;
await cloudflare(
  `${base}/event_notifications/r2/${names.quarantine}/configuration/queues/${queueId}`,
  'PUT',
  {
    rules: [
      {
        prefix: 'uploads/',
        actions: ['PutObject', 'CompleteMultipartUpload'],
        description: 'Scan completed file uploads',
      },
    ],
  },
);
const subdomain = await cloudflare<{ subdomain: string }>(`${base}/workers/subdomain`);
const origin =
  process.env.APP_ORIGIN ||
  `https://${process.env.API_WORKER_NAME || 'file-vault-api'}.${subdomain.subdomain}.workers.dev`;
await cloudflare(`${base}/r2/buckets/${names.quarantine}/cors`, 'PUT', {
  rules: [
    {
      allowed: {
        origins: [origin, 'http://127.0.0.1:5173'],
        methods: ['PUT', 'HEAD'],
        headers: ['content-type', 'if-none-match', 'x-amz-*'],
      },
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3600,
    },
  ],
});
let contents = await readFile(resolve(root, '.env'), 'utf8').catch(() =>
  readFile(resolve(root, '.env.example'), 'utf8'),
);
for (const [key, value] of Object.entries({ D1_DATABASE_ID: databaseId, APP_ORIGIN: origin }))
  contents = new RegExp(`^${key}=.*$`, 'm').test(contents)
    ? contents.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
    : `${contents}\n${key}=${value}\n`;
await writeFile(resolve(root, '.env'), contents);
console.log(`Cloudflare resources prepared. D1: ${databaseId}. Application origin: ${origin}.`);
