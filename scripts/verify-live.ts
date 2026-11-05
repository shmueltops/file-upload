import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvironment, requireVariables, cloudflare } from './cloudflare-api';
import { hashPassword } from '../packages/shared/src/services/users';
import { PART_SIZE } from '../packages/shared/src/contracts';
loadEnvironment();
requireVariables('APP_ORIGIN', 'D1_DATABASE_ID');
const origin = process.env.APP_ORIGIN!,
  account = process.env.CLOUDFLARE_ACCOUNT_ID!,
  database = process.env.D1_DATABASE_ID!;
const id = crypto.randomUUID(),
  email = `verification-${id.slice(0, 8)}@test.invalid`,
  password = crypto.randomUUID(),
  now = Date.now();
await cloudflare(`/accounts/${account}/d1/database/${database}/query`, 'POST', {
  sql: "INSERT INTO users(id,email,email_key,password_hash,role,must_change_password,created_at,updated_at) VALUES(?,?,?,?,'admin',0,?,?)",
  params: [id, email, email, await hashPassword(password), now, now],
});
await mkdir('.local', { recursive: true });
await writeFile(
  '.local/live-verification.json',
  JSON.stringify({ email, password, origin }, null, 2),
);
let cookie = '';
async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (response.headers.get('set-cookie'))
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  const result = (await response.json()) as { error?: string };
  if (!response.ok)
    throw new Error(`${method} ${path} failed (${response.status}): ${result.error}`);
  return result as T;
}
type File = {
  id: string;
  filename: string;
  status: string;
  actual_size: number;
  scan_attempt_count: number;
  block_reason: string | null;
};
async function poll(id: string): Promise<File> {
  for (let i = 0; i < 120; i++) {
    const { file } = await api<{ file: File }>(`/files/${id}`);
    if (['done', 'infected', 'failed'].includes(file.status)) return file;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Live processing did not reach a terminal state within two minutes.');
}
const report: string[] = [];
await api('/auth/login', 'POST', { email, password });
report.push('Worker Argon2id authentication and secure session cookie');
const folderPath = `Verification ${id.slice(0, 8)}/Projects/Website/assets`;
await api('/folders/ensure-paths', 'POST', { paths: [folderPath, `${folderPath}/empty`] });
report.push('Nested path creation and an empty directory');
let approved: File | undefined;
for (let attempt = 0; attempt < 5; attempt++) {
  const text = 'Verified through the deployed Hono API, private R2, and Queue Worker.';
  const upload = await api<{
    id: string;
    generation: string;
    url: string;
    headers: Record<string, string>;
  }>('/uploads', 'POST', {
    filename: `report-${attempt}.txt`,
    size: text.length,
    mimeType: 'text/plain',
    folderPath,
    clientUploadId: crypto.randomUUID(),
  });
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: text });
  if (!put.ok) throw new Error(`Worker-generated presigned PUT failed: ${put.status}`);
  // Intentionally do not call /complete: native R2 event delivery must work independently.
  const file = await poll(upload.id);
  if (file.status === 'failed') throw new Error('Live queue processing failed.');
  if (file.status === 'done') {
    const { url } = await api<{ url: string }>(`/files/${file.id}/download`);
    const response = await fetch(`${origin}${url}`, { headers: { Cookie: cookie } });
    if ((await response.text()) !== text)
      throw new Error('Authorized download contents did not match.');
    approved = file;
    break;
  }
}
if (!approved)
  throw new Error('The simulated scanner selected infected five times; run verification again.');
report.push(
  'Direct presigned upload → native R2 event → Queues → approved copy → authenticated download',
);
const infection = 'simulated malware fixture',
  infectedUpload = await api<{
    id: string;
    generation: string;
    url: string;
    headers: Record<string, string>;
  }>('/uploads', 'POST', {
    filename: 'VIRUS-example.txt',
    size: infection.length,
    mimeType: 'text/plain',
    folderPath,
    clientUploadId: crypto.randomUUID(),
  });
const infectedPut = await fetch(infectedUpload.url, {
  method: 'PUT',
  headers: infectedUpload.headers,
  body: infection,
});
if (!infectedPut.ok) throw new Error('Infected fixture upload failed.');
const infected = await poll(infectedUpload.id);
if (infected.status !== 'infected' || infected.block_reason !== 'virus in name')
  throw new Error('Expected deterministic infected verdict.');
const denied = await fetch(`${origin}/api/files/${infected.id}/download`, {
  headers: { Cookie: cookie },
});
if (denied.status !== 409) throw new Error('An infected download was not blocked.');
const history = await api<{ attempts: { result: string }[] }>(
  `/admin/jobs/${infected.id}/attempts`,
);
if (history.attempts.length !== 1 || history.attempts[0].result !== 'infected')
  throw new Error('Live scan audit did not match.');
report.push('Infected download blocking and one audited attempt');
const size = 21 * 1024 * 1024,
  multipart = await api<{ id: string; generation: string }>('/uploads', 'POST', {
    filename: 'multipart.bin',
    size,
    mimeType: 'application/octet-stream',
    folderPath,
    clientUploadId: crypto.randomUUID(),
  });
const signed = await api<{ parts: { partNumber: number; url: string }[] }>(
  `/uploads/${multipart.id}/parts`,
  'POST',
  { generation: multipart.generation, parts: [1, 2] },
);
const parts = await Promise.all(
  signed.parts.map(async (p) => {
    const response = await fetch(p.url, {
      method: 'PUT',
      body: Buffer.alloc(Math.min(PART_SIZE, size - (p.partNumber - 1) * PART_SIZE), 7),
    });
    if (!response.ok) throw new Error(`Real multipart part failed: ${response.status}`);
    return { partNumber: p.partNumber, etag: response.headers.get('etag')! };
  }),
);
await api(`/uploads/${multipart.id}/complete`, 'POST', { generation: multipart.generation, parts });
const large = await poll(multipart.id);
if (!['done', 'infected'].includes(large.status) || large.actual_size !== size)
  throw new Error('Live multipart processing failed.');
report.push('Multipart signing, server ListParts verification, completion and processing');
await api(`/files/${approved.id}`, 'DELETE');
const deletedAccess = await fetch(`${origin}/api/files/${approved.id}/content`, {
  headers: { Cookie: cookie },
});
if (deletedAccess.status !== 404)
  throw new Error('Deleted-file access was not immediately revoked.');
report.push('Immediate download revocation after delete');
const folderList = await api<{ folders: { id: string; path: string }[] }>('/folders');
const rootFolder = folderList.folders.find((f) => f.path === folderPath.split('/')[0])!;
await api(`/folders/${rootFolder.id}`, 'DELETE');
report.push('Recursive folder deletion accepted');
await mkdir('artifacts', { recursive: true });
await writeFile(
  'artifacts/live-verification.json',
  JSON.stringify({ origin, verifiedAt: new Date().toISOString(), checks: report }, null, 2),
);
console.log(report.map((check) => `PASS: ${check}`).join('\n'));
