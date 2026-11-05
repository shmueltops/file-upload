import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { Miniflare } from 'miniflare';
import { buildWorkers } from '../scripts/build';
import { localRuntime, migrateLocal } from '../scripts/runtime';
import { hashPassword } from '../packages/shared/src/services/users';
import { processFile, cleanupFile } from '../packages/shared/src/services/processing';
import { resolvePath, changeFolder } from '../packages/shared/src/services/folders';
import {
  startUpload,
  getFile,
  requestDelete,
  requestFolderDelete,
} from '../packages/shared/src/services/files';
import { run, first, all } from '../packages/shared/src/db/client';
import type { ServiceBindings } from '../packages/shared/src/services/types';
let mf: Miniflare, env: ServiceBindings, adminCookie: string, userCookie: string;
const origin = 'http://localhost',
  adminId = crypto.randomUUID(),
  userId = crypto.randomUUID(),
  password = crypto.randomUUID();
async function request(path: string, method = 'GET', data?: unknown, cookie = adminCookie) {
  return mf.dispatchFetch(`${origin}/api${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
beforeAll(async () => {
  await buildWorkers();
  mf = localRuntime(crypto.randomUUID() + crypto.randomUUID(), false, 0, origin);
  await mf.ready;
  const db = await migrateLocal(mf);
  env = await mf.getBindings<ServiceBindings>('vault-api');
  const hash = await hashPassword(password);
  for (const [id, email, role] of [
    [adminId, 'admin@test.invalid', 'admin'],
    [userId, 'user@test.invalid', 'user'],
  ])
    await db
      .prepare(
        'INSERT INTO users(id,email,email_key,password_hash,role,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)',
      )
      .bind(id, email, email, hash, role, Date.now(), Date.now())
      .run();
  const admin = await request('/auth/login', 'POST', { email: 'admin@test.invalid', password }, '');
  expect(admin.status).toBe(200);
  adminCookie = admin.headers.get('set-cookie')!.split(';')[0];
  const user = await request('/auth/login', 'POST', { email: 'user@test.invalid', password }, '');
  expect(user.status).toBe(200);
  userCookie = user.headers.get('set-cookie')!.split(';')[0];
});
afterAll(async () => {
  await mf?.dispose();
});
async function staged(filename: string, body = 'test data') {
  const id = crypto.randomUUID();
  const info = await startUpload(env, userId, {
    filename,
    size: new TextEncoder().encode(body).length,
    mimeType: 'text/plain',
    folderPath: '',
    clientUploadId: id,
  });
  const file = (await getFile(env, id))!;
  await env.QUARANTINE.put(file.quarantine_key, body, {
    customMetadata: { 'file-id': id, generation: info.generation },
  });
  return file;
}
describe('runtime authorization and D1 constraints', () => {
  it('rejects anonymous, foreign-origin, and regular-user admin calls', async () => {
    expect((await request('/files', 'GET', undefined, '')).status).toBe(401);
    expect((await request('/admin/users', 'GET', undefined, userCookie)).status).toBe(403);
    const response = await mf.dispatchFetch(`${origin}/api/folders`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        Origin: 'https://evil.invalid',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: 'Escape' }),
    });
    expect(response.status).toBe(403);
  });
  it('requires rotation for new accounts and invalidates old sessions after logout', async () => {
    const initial = crypto.randomUUID(),
      email = `${crypto.randomUUID()}@test.invalid`;
    expect((await request('/admin/users', 'POST', { email, password: initial })).status).toBe(201);
    const login = await request('/auth/login', 'POST', { email, password: initial }, '');
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await request('/files', 'GET', undefined, cookie)).status).toBe(403);
    const rotate = await request(
      '/auth/change-password',
      'POST',
      { currentPassword: initial, password: crypto.randomUUID() },
      cookie,
    );
    expect(rotate.status).toBe(200);
    const newCookie = rotate.headers.get('set-cookie')!.split(';')[0];
    expect((await request('/files', 'GET', undefined, newCookie)).status).toBe(200);
    await request('/auth/logout', 'POST', {}, newCookie);
    expect((await request('/auth/me', 'GET', undefined, newCookie)).status).toBe(401);
  });
  it('concurrently ensures a single canonical folder tree including empty folders', async () => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        resolvePath(env, userId, 'Documents/Projects/Website/assets/images', true),
      ),
    );
    const rows = await all(
      env.DB,
      'SELECT * FROM folders WHERE user_id=? AND name_key=?',
      userId,
      'images',
    );
    expect(rows).toHaveLength(1);
    expect(
      (await request('/folders/ensure-paths', 'POST', { paths: ['Empty/Also empty'] }, userCookie))
        .status,
    ).toBe(200);
  });
  it('enforces root case-insensitive filename uniqueness and ownership', async () => {
    const f = await staged('Unique.TXT');
    await expect(staged('unique.txt')).rejects.toThrow(/already exists/);
    expect((await request(`/files/${f.id}`, 'GET', undefined, adminCookie)).status).toBe(404);
  });
  it('keeps unfinished and abandoned transfers out of the user file list', async () => {
    const file = await staged('unfinished.txt');
    const result = await request('/files?folderPath=', 'GET', undefined, userCookie);
    expect(
      ((await result.json()) as { files: { id: string }[] }).files.some((f) => f.id === file.id),
    ).toBe(false);
    await processFile(env, file.id, undefined, () => 1);
    const finished = await request('/files?folderPath=', 'GET', undefined, userCookie);
    expect(
      ((await finished.json()) as { files: { id: string }[] }).files.some((f) => f.id === file.id),
    ).toBe(true);
  });
  it('rejects moves that form cycles', async () => {
    const a = await resolvePath(env, userId, 'Cycle/Child', true);
    const parent = await resolvePath(env, userId, 'Cycle');
    await expect(
      changeFolder(env, userId, parent!, { destinationParentPath: 'Cycle/Child' }),
    ).rejects.toThrow(/inside itself/);
    expect(a).toBeTruthy();
  });
});
describe('processing and cleanup', () => {
  it('limits operational scanner failures to three audited attempts', async () => {
    const f = await staged('scanner-outage.txt');
    const broken = () => {
      throw new Error('Simulated scanner outage');
    };
    await expect(processFile(env, f.id, undefined, broken)).rejects.toThrow(
      'Simulated scanner outage',
    );
    await expect(processFile(env, f.id, undefined, broken)).rejects.toThrow(
      'Simulated scanner outage',
    );
    await processFile(env, f.id, undefined, broken);
    const current = (await getFile(env, f.id))!;
    expect(current.status).toBe('failed');
    expect(current.scan_attempt_count).toBe(3);
    expect(
      await all(env.DB, "SELECT id FROM scan_attempts WHERE file_id=? AND result='error'", f.id),
    ).toHaveLength(3);
  });
  it('retries failed promotion without calling the scanner again', async () => {
    const f = await staged('promotion-retry.txt');
    const broken = new Proxy(env.CLEAN, {
      get(target, property) {
        if (property === 'put')
          return async () => {
            throw new Error('Simulated storage outage');
          };
        return Reflect.get(target, property);
      },
    });
    await expect(processFile({ ...env, CLEAN: broken }, f.id, undefined, () => 1)).rejects.toThrow(
      'Simulated storage outage',
    );
    expect((await getFile(env, f.id))!.scan_verdict).toBe('clean');
    await processFile(env, f.id, undefined, () => {
      throw new Error('Scanner must not run twice');
    });
    const done = (await getFile(env, f.id))!;
    expect(done.status).toBe('done');
    expect(done.scan_attempt_count).toBe(1);
  });
  it('cannot publish a clean destination when deletion revokes a promotion claim', async () => {
    const f = await staged('cancel-during-promotion.txt');
    const cancelling = new Proxy(env.CLEAN, {
      get(target, property) {
        if (property === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            const result = await env.CLEAN.put(...args);
            await requestDelete(env, userId, f.id);
            return result;
          };
        return Reflect.get(target, property);
      },
    });
    await processFile({ ...env, CLEAN: cancelling }, f.id, undefined, () => 1);
    const cancelled = (await getFile(env, f.id))!;
    expect(cancelled.status).toBe('deleting');
    expect(cancelled.clean_key).toBeNull();
    expect((await request(`/files/${f.id}/download`, 'GET', undefined, userCookie)).status).toBe(
      404,
    );
  });
  it('promotes exactly the approved object, supports range download and ignores duplicate work', async () => {
    const f = await staged('approved.txt', 'Hello approved world');
    await processFile(env, f.id, f.upload_generation, () => 1);
    await processFile(env, f.id, f.upload_generation, () => 0);
    const completed = (await getFile(env, f.id))!;
    expect(completed.status).toBe('done');
    expect(completed.scan_attempt_count).toBe(1);
    expect(await env.QUARANTINE.head(f.quarantine_key)).toBeNull();
    expect((await request(`/files/${f.id}/download`, 'GET', undefined, userCookie)).status).toBe(
      200,
    );
    const download = await request(`/files/${f.id}/content`, 'GET', undefined, userCookie);
    expect(await download.text()).toBe('Hello approved world');
    const range = await mf.dispatchFetch(`${origin}/api/files/${f.id}/content`, {
      headers: { Cookie: userCookie, Range: 'bytes=0-4' },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('Hello');
    const attempts = await all(env.DB, 'SELECT * FROM scan_attempts WHERE file_id=?', f.id);
    expect(attempts).toHaveLength(1);
  });
  it('blocks infected downloads for users and admins and records the reason', async () => {
    const f = await staged('VIRUS.txt');
    await processFile(env, f.id, f.upload_generation);
    expect((await getFile(env, f.id))!.block_reason).toBe('virus in name');
    expect((await request(`/files/${f.id}/download`, 'GET', undefined, userCookie)).status).toBe(
      409,
    );
    expect((await request(`/files/${f.id}/download`, 'GET', undefined, adminCookie)).status).toBe(
      404,
    );
  });
  it('never starts work under another valid lease, then recovers an expired lease', async () => {
    const f = await staged('lease.txt');
    await run(
      env.DB,
      'UPDATE files SET claim_token=?,lease_expires_at=? WHERE id=?',
      'old-claim',
      Date.now() + 60_000,
      f.id,
    );
    await expect(processFile(env, f.id)).rejects.toThrow(/lease/);
    expect((await getFile(env, f.id))!.scan_attempt_count).toBe(0);
    await run(env.DB, 'UPDATE files SET lease_expires_at=0 WHERE id=?', f.id);
    await processFile(env, f.id, undefined, () => 1);
    expect((await getFile(env, f.id))!.status).toBe('done');
  });
  it('does not reset the three-attempt ceiling after an interrupted scanner', async () => {
    const f = await staged('exhausted.txt');
    await run(env.DB, 'UPDATE files SET scan_attempt_count=3 WHERE id=?', f.id);
    await processFile(env, f.id);
    expect((await getFile(env, f.id))!.status).toBe('failed');
  });
  it('rejects tampered size and does not scan it', async () => {
    const f = await staged('wrongsize.txt');
    await env.QUARANTINE.put(f.quarantine_key, 'larger than expected', {
      customMetadata: { 'file-id': f.id, generation: f.upload_generation },
    });
    await processFile(env, f.id);
    const updated = (await getFile(env, f.id))!;
    expect(updated.status).toBe('failed');
    expect(updated.scan_attempt_count).toBe(0);
  });
  it('revokes immediately, preserves names until physical cleanup, then releases them', async () => {
    const f = await staged('delete-me.txt');
    await processFile(env, f.id, undefined, () => 1);
    await requestDelete(env, userId, f.id);
    expect((await request(`/files/${f.id}/content`, 'GET', undefined, userCookie)).status).toBe(
      404,
    );
    await expect(staged('DELETE-ME.txt')).rejects.toThrow(/already exists/);
    await run(env.DB, 'UPDATE files SET cleanup_after=0 WHERE id=?', f.id);
    await cleanupFile(env, f.id);
    expect((await getFile(env, f.id))!.status).toBe('deleted');
    expect(await staged('delete-me.txt')).toBeTruthy();
  });
  it('atomically rolls back related D1 mutations', async () => {
    const id = crypto.randomUUID();
    await expect(
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO folders(id,user_id,name,name_key,created_at,updated_at) VALUES(?,?,'rollback','rollback',0,0)",
        ).bind(id, userId),
        env.DB.prepare(
          "INSERT INTO users(id,email,email_key,password_hash,role,created_at,updated_at) VALUES('bad','bad','bad','bad','invalid',0,0)",
        ),
      ]),
    ).rejects.toThrow();
    expect(await first(env.DB, 'SELECT id FROM folders WHERE id=?', id)).toBeNull();
  });
});
