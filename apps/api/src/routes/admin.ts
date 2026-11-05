import { Hono } from 'hono';
import { z } from 'zod';
import { all, first } from '../../../../packages/shared/src/db/client';
import { fileDto } from '../../../../packages/shared/src/services/files';
import { createUser } from '../../../../packages/shared/src/services/users';
import { passwordInput } from '../../../../packages/shared/src/contracts';
import { AppError } from '../../../../packages/shared/src/services/types';
import type { StoredFile } from '../../../../packages/shared/src/db/schema';
import { adminOnly, type ApiEnv } from '../middleware';
export const adminRoutes = new Hono<ApiEnv>();
adminRoutes.use('*', adminOnly);
adminRoutes.get('/users', async (c) =>
  c.json({
    users: await all(
      c.env.DB,
      'SELECT id,email,role,must_change_password,created_at,last_login_at FROM users ORDER BY created_at DESC LIMIT 200',
    ),
  }),
);
adminRoutes.post('/users', async (c) => {
  const i = z
    .object({
      email: z.email().max(254),
      password: passwordInput,
      role: z.enum(['user', 'admin']).default('user'),
    })
    .parse(await c.req.json());
  return c.json({ user: await createUser(c.env, i.email, i.password, i.role) }, 201);
});
const listJobs = async (c: import('hono').Context<ApiEnv>) => {
  const filters: string[] = [],
    values: unknown[] = [];
  for (const [key, column] of [
    ['status', 'f.status'],
    ['owner', 'f.user_id'],
    ['stage', 'f.stage'],
  ] as const)
    if (c.req.query(key)) {
      filters.push(`${column}=?`);
      values.push(c.req.query(key));
    }
  if (c.req.query('stuck') === 'true') {
    filters.push('f.lease_expires_at IS NOT NULL AND f.lease_expires_at<?');
    values.push(Date.now());
  }
  if (c.req.query('cursor')) {
    filters.push('f.id>?');
    values.push(c.req.query('cursor'));
  }
  const rows = await all<StoredFile & { email: string }>(
    c.env.DB,
    `SELECT f.*,u.email FROM files f JOIN users u ON u.id=f.user_id ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY f.id LIMIT 101`,
    ...values,
  );
  const counts = await all<{ status: string; count: number }>(
    c.env.DB,
    'SELECT status,COUNT(*) AS count FROM files GROUP BY status',
  );
  return c.json({
    files: rows.slice(0, 100).map(fileDto),
    counts,
    nextCursor: rows.length > 100 ? rows[99].id : null,
  });
};
adminRoutes.get('/files', listJobs);
adminRoutes.get('/jobs', listJobs);
adminRoutes.get('/jobs/:id', async (c) => {
  const row = await first<StoredFile & { email: string }>(
    c.env.DB,
    'SELECT f.*,u.email FROM files f JOIN users u ON u.id=f.user_id WHERE f.id=?',
    c.req.param('id'),
  );
  if (!row) throw new AppError(404, 'File not found.');
  return c.json({ file: fileDto(row) });
});
adminRoutes.get('/jobs/:id/attempts', async (c) =>
  c.json({
    attempts: await all(
      c.env.DB,
      'SELECT * FROM scan_attempts WHERE file_id=? ORDER BY attempt_number',
      c.req.param('id'),
    ),
  }),
);
