import { Hono } from 'hono';
import { z } from 'zod';
import {
  listFolders,
  resolvePath,
  ensurePaths,
  changeFolder,
} from '../../../../packages/shared/src/services/folders';
import { requestFolderDelete } from '../../../../packages/shared/src/services/files';
import type { ApiEnv } from '../middleware';
export const folderRoutes = new Hono<ApiEnv>();
folderRoutes.get('/', async (c) => c.json({ folders: await listFolders(c.env, c.get('user').id) }));
folderRoutes.post('/ensure-paths', async (c) => {
  const input = z.object({ paths: z.array(z.string()).max(10_000) }).parse(await c.req.json());
  return c.json({ folders: await ensurePaths(c.env, c.get('user').id, input.paths) });
});
folderRoutes.post('/', async (c) => {
  const { path } = z.object({ path: z.string().min(1) }).parse(await c.req.json());
  await resolvePath(c.env, c.get('user').id, path, true);
  return c.json({ folders: await listFolders(c.env, c.get('user').id) }, 201);
});
folderRoutes.patch('/:id', async (c) => {
  const input = z
    .object({ name: z.string().optional(), destinationParentPath: z.string().optional() })
    .parse(await c.req.json());
  return c.json({ folders: await changeFolder(c.env, c.get('user').id, c.req.param('id'), input) });
});
folderRoutes.delete('/:id', async (c) => {
  await requestFolderDelete(c.env, c.get('user').id, c.req.param('id'));
  return c.json({ ok: true }, 202);
});
