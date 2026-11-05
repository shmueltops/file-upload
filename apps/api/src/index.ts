import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import { authenticate, csrf, type ApiEnv } from './middleware';
import { auth } from './routes/auth';
import { uploads, localStorage } from './routes/uploads';
import { fileRoutes } from './routes/files';
import { folderRoutes } from './routes/folders';
import { adminRoutes } from './routes/admin';
import { AppError } from '../../../packages/shared/src/services/types';

const api = new Hono<ApiEnv>();
api.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }), async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
api.use('*', csrf, authenticate);
api.use('*', async (c, next) =>
  c.req.path.includes('/__local/')
    ? next()
    : bodyLimit({
        maxSize: 2 * 1024 * 1024,
        onError: (c) => c.json({ error: 'The request exceeds 2 MiB.' }, 413),
      })(c, next),
);
api.get('/health', (c) => c.json({ ok: true, scanner: 'simulation' }));
api.route('/auth', auth);
api.route('/uploads', uploads);
api.route('/files', fileRoutes);
api.route('/folders', folderRoutes);
api.route('/admin', adminRoutes);
const app = new Hono<ApiEnv>();
app.route('/__local', localStorage);
app.route('/api', api);
app.get('*', async (c) =>
  c.env.ASSETS
    ? c.env.ASSETS.fetch(c.req.raw)
    : c.json({ error: 'Use the frontend development server.' }, 404),
);
app.onError((error, c) => {
  if (error instanceof AppError)
    return c.json({ error: error.message, code: error.code }, error.status as 400);
  if (error instanceof ZodError)
    return c.json(
      {
        error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        code: 'validation_error',
      },
      422,
    );
  if (
    error instanceof Error &&
    /Names |name is reserved|Folders cannot|full path|full file path|Names must/.test(error.message)
  )
    return c.json({ error: error.message, code: 'invalid_path' }, 422);
  console.error(
    JSON.stringify({
      event: 'request_error',
      path: c.req.path,
      error: String(error).slice(0, 1000),
    }),
  );
  return c.json(
    { error: 'The request could not be completed. Retry shortly.', code: 'internal_error' },
    500,
  );
});
export default {
  fetch(request: Request, env: ApiEnv['Bindings'], ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Root API aliases preserve the assignment's HTTP route contract without
    // applying API authentication middleware to SPA documents/assets.
    if (/^\/(auth|uploads|files|folders|admin)(\/|$)/.test(url.pathname)) {
      url.pathname = `/api${url.pathname}`;
      request = new Request(url, request);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<ApiEnv['Bindings']>;
