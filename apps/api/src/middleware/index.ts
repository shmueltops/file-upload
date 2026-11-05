import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { sessionUser } from '../../../../packages/shared/src/services/users';
import { AppError, type ServiceBindings } from '../../../../packages/shared/src/services/types';
import type { StoredUser } from '../../../../packages/shared/src/db/schema';

export type ApiEnv = {
  Bindings: ServiceBindings & { ASSETS?: Fetcher; LOGIN_LIMITER?: RateLimit };
  Variables: { user: StoredUser };
};
export const cookieName = (env: ServiceBindings) =>
  env.LOCAL_MODE === 'true' ? 'vault_session' : '__Host-vault_session';
export const authenticate = createMiddleware<ApiEnv>(async (c, next) => {
  const path = c.req.path.replace(/^\/api/, '');
  if (path === '/auth/login' || path === '/health' || path.startsWith('/__local/')) return next();
  const user = await sessionUser(c.env, getCookie(c, cookieName(c.env)));
  // Logout must also clear expired, invalid, or already-revoked cookies.
  if (!user) {
    if (path === '/auth/logout') return next();
    throw new AppError(401, 'Sign in to continue.', 'unauthorized');
  }
  c.set('user', user);
  if (
    user.must_change_password &&
    !['/auth/me', '/auth/logout', '/auth/change-password'].includes(path)
  )
    throw new AppError(
      403,
      'Change your initial password to continue.',
      'password_change_required',
    );
  await next();
});
export const adminOnly = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.get('user').role !== 'admin') throw new AppError(403, 'Administrator access is required.');
  await next();
});
export const csrf = createMiddleware<ApiEnv>(async (c, next) => {
  const path = c.req.path.replace(/^\/api/, '');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !path.startsWith('/__local/')) {
    const origin = c.req.header('Origin');
    if (!origin || (origin !== c.env.APP_ORIGIN && origin !== new URL(c.req.url).origin))
      throw new AppError(403, 'This request must come from the application origin.');
    if (c.req.method !== 'DELETE' && !c.req.header('Content-Type')?.includes('application/json'))
      throw new AppError(415, 'Use application/json for this request.');
  }
  await next();
});
