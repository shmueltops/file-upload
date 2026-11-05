import { Hono } from 'hono';
import {
  listUserFiles,
  ownedFile,
  requestDelete,
  fileDto,
} from '../../../../packages/shared/src/services/files';
import { AppError } from '../../../../packages/shared/src/services/types';
import type { ApiEnv } from '../middleware';
import {
  filePreview,
  MAX_TEXT_PREVIEW_BYTES,
} from '../../../../packages/shared/src/contracts/previews';

export const fileRoutes = new Hono<ApiEnv>();
fileRoutes.get('/', async (c) => {
  const rows = await listUserFiles(
    c.env,
    c.get('user').id,
    c.req.query('folderPath'),
    c.req.query('ids')?.split(',').filter(Boolean),
    c.req.query('cursor'),
  );
  return c.json({ files: rows.slice(0, 200), nextCursor: rows.length > 200 ? rows[199].id : null });
});
fileRoutes.get('/:id', async (c) =>
  c.json({ file: fileDto(await ownedFile(c.env, c.get('user').id, c.req.param('id'))) }),
);
fileRoutes.delete('/:id', async (c) => {
  await requestDelete(c.env, c.get('user').id, c.req.param('id'));
  return c.json({ ok: true }, 202);
});
fileRoutes.get('/:id/download', async (c) => {
  const file = await ownedFile(c.env, c.get('user').id, c.req.param('id'));
  if (file.status !== 'done' || !file.clean_key)
    throw new AppError(409, 'Only approved files are available to download.');
  return c.json({ url: `/api/files/${file.id}/content` });
});
fileRoutes.get('/:id/content', async (c) => {
  const file = await ownedFile(c.env, c.get('user').id, c.req.param('id'));
  if (file.status !== 'done' || !file.clean_key || !file.clean_etag)
    throw new AppError(409, 'Only approved files are available to download.');
  const preview = c.req.query('preview') === '1';
  const format = preview ? filePreview(file.filename) : null;
  if (preview && !format) throw new AppError(415, 'This format is available to download only.');
  if (
    format &&
    ['text', 'markdown'].includes(format.kind) &&
    (file.actual_size ?? file.expected_size) > MAX_TEXT_PREVIEW_BYTES
  )
    throw new AppError(
      413,
      'This text file is too large to preview. Download it to read the full file.',
    );
  const object = await c.env.CLEAN.get(file.clean_key, {
    range: c.req.raw.headers,
    onlyIf: { etagMatches: file.clean_etag },
  });
  if (!object || !('body' in object))
    throw new AppError(409, 'The approved file is currently unavailable.');
  const headers = new Headers({
    'Content-Type': format?.contentType ?? 'application/octet-stream',
    'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.filename).replaceAll("'", '%27')}`,
    'Content-Security-Policy': `default-src 'none'; script-src 'none'; object-src ${format?.kind === 'pdf' ? "'self'" : "'none'"}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    ETag: object.httpEtag,
  });
  if (
    c.req.header('Range') &&
    object.range &&
    'offset' in object.range &&
    'length' in object.range &&
    object.range.offset !== undefined &&
    object.range.length !== undefined
  ) {
    headers.set(
      'Content-Range',
      `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
    );
    headers.set('Content-Length', String(object.range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
});
