import { Hono } from 'hono';
import { z } from 'zod';
import { PART_SIZE, uploadInput } from '../../../../packages/shared/src/contracts';
import {
  startUpload,
  ownedFile,
  signParts,
  completeUpload,
  requestDelete,
  uploadInfo,
  fileDto,
} from '../../../../packages/shared/src/services/files';
import { listParts, verifyLocalToken } from '../../../../packages/shared/src/services/r2';
import { run } from '../../../../packages/shared/src/db/client';
import { AppError } from '../../../../packages/shared/src/services/types';
import type { ApiEnv } from '../middleware';

export const uploads = new Hono<ApiEnv>();
uploads.post('/', async (c) =>
  c.json(await startUpload(c.env, c.get('user').id, uploadInput.parse(await c.req.json())), 201),
);
uploads.post('/:id/parts', async (c) => {
  const input = z
    .object({ generation: z.uuid(), parts: z.array(z.number().int()).max(16) })
    .parse(await c.req.json());
  return c.json({
    parts: await signParts(
      c.env,
      c.get('user').id,
      c.req.param('id'),
      input.generation,
      input.parts,
    ),
  });
});
uploads.post('/:id/complete', async (c) => {
  const input = z
    .object({
      generation: z.uuid(),
      parts: z
        .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().max(2048) }))
        .max(200)
        .optional(),
    })
    .parse(await c.req.json());
  return c.json({
    file: await completeUpload(
      c.env,
      c.get('user').id,
      c.req.param('id'),
      input.generation,
      input.parts,
    ),
  });
});
uploads.get('/:id', async (c) => {
  const f = await ownedFile(c.env, c.get('user').id, c.req.param('id'));
  return c.json({
    file: fileDto(f),
    upload:
      ['pending', 'uploading'].includes(f.status) && f.upload_expires_at > Date.now()
        ? await uploadInfo(c.env, f)
        : null,
    parts:
      f.multipart_upload_id && ['pending', 'uploading'].includes(f.status)
        ? await listParts(c.env, f)
        : [],
  });
});
uploads.delete('/:id', async (c) => {
  await requestDelete(c.env, c.get('user').id, c.req.param('id'));
  return c.json({ ok: true }, 202);
});

// Development adapter for the R2 S3 data plane. Production has no such route.
export const localStorage = new Hono<ApiEnv>();
localStorage.options('/r2', (c) =>
  c.body(null, 204, {
    'Access-Control-Allow-Origin': c.env.APP_ORIGIN,
    'Access-Control-Allow-Methods': 'PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,if-none-match',
    'Access-Control-Expose-Headers': 'ETag',
  }),
);
localStorage.put('/r2', async (c) => {
  if (c.env.LOCAL_MODE !== 'true') throw new AppError(404, 'Not found.');
  let token;
  try {
    token = await verifyLocalToken(c.env, c.req.query('token') ?? '');
  } catch {
    throw new AppError(403, 'Upload URL expired or is invalid.');
  }
  // Validate session state at the emulated boundary in addition to URL checks.
  const { getFile } = await import('../../../../packages/shared/src/services/files');
  const f = await getFile(c.env, token.id);
  if (
    !f ||
    f.upload_generation !== token.generation ||
    f.delete_requested_at ||
    !['pending', 'uploading'].includes(f.status)
  )
    throw new AppError(409, 'Upload is no longer active.');
  const length = Number(c.req.header('Content-Length'));
  if (
    !Number.isFinite(length) ||
    length < 0 ||
    (length > PART_SIZE && token.part !== undefined) ||
    length > 20 * 1024 * 1024
  )
    throw new AppError(413, 'Invalid upload length.');
  let etag: string;
  if (token.part) {
    if (!f.multipart_upload_id) throw new AppError(409, 'Multipart session is missing.');
    const part = await c.env.QUARANTINE.resumeMultipartUpload(
      f.quarantine_key,
      f.multipart_upload_id,
    ).uploadPart(token.part, c.req.raw.body!);
    etag = part.etag;
    await c.env.QUARANTINE.put(
      `parts/${f.id}/${f.upload_generation}/${token.part}`,
      JSON.stringify({ partNumber: token.part, etag, size: length }),
    );
  } else {
    if (c.req.header('If-None-Match') !== '*')
      throw new AppError(403, 'The create-once condition is required.');
    const object = await c.env.QUARANTINE.put(
      f.quarantine_key,
      c.req.raw.body ?? new Uint8Array(),
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: f.mime_type },
        customMetadata: { 'file-id': f.id, generation: f.upload_generation },
      },
    );
    if (!object) throw new AppError(412, 'An object is already committed at this key.');
    etag = object.etag;
    await c.env.JOBS.send({ type: 'process', fileId: f.id, generation: f.upload_generation });
  }
  return c.body(null, 200, {
    ETag: etag,
    'Access-Control-Allow-Origin': c.env.APP_ORIGIN,
    'Access-Control-Expose-Headers': 'ETag',
  });
});
