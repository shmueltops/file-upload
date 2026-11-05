import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { loginInput, passwordInput } from '../../../../packages/shared/src/contracts';
import { database } from '../../../../packages/shared/src/db/client';
import { users } from '../../../../packages/shared/src/db/schema';
import {
  checkPassword,
  hashPassword,
  emailKey,
  publicUser,
  sessionToken,
} from '../../../../packages/shared/src/services/users';
import { AppError } from '../../../../packages/shared/src/services/types';
import { cookieName, type ApiEnv } from '../middleware';

export const auth = new Hono<ApiEnv>();
auth.post('/login', async (c) => {
  if (c.env.LOGIN_LIMITER) {
    const result = await c.env.LOGIN_LIMITER.limit({
      key: c.req.header('CF-Connecting-IP') ?? 'unknown',
    });
    if (!result.success) throw new AppError(429, 'Too many sign-in attempts. Try again shortly.');
  }
  const input = loginInput.parse(await c.req.json());
  const user = (
    await database(c.env.DB)
      .select()
      .from(users)
      .where(eq(users.email_key, emailKey(input.email)))
  )[0];
  if (!user || !(await checkPassword(input.password, user.password_hash)))
    throw new AppError(401, 'Email or password is incorrect.');
  await database(c.env.DB)
    .update(users)
    .set({ last_login_at: Date.now() })
    .where(eq(users.id, user.id));
  setCookie(c, cookieName(c.env), await sessionToken(c.env, user), {
    httpOnly: true,
    secure: c.env.LOCAL_MODE !== 'true',
    sameSite: 'Lax',
    path: '/',
    maxAge: 8 * 60 * 60,
  });
  return c.json({ user: publicUser(user) });
});
auth.get('/me', (c) => c.json({ user: publicUser(c.get('user')) }));
auth.post('/logout', async (c) => {
  const user = c.get('user');
  // __Host- cookie deletion must carry the same Secure and Path requirements as creation.
  deleteCookie(c, cookieName(c.env), {
    path: '/',
    secure: c.env.LOCAL_MODE !== 'true',
    httpOnly: true,
    sameSite: 'Lax',
  });
  if (user)
    await database(c.env.DB)
      .update(users)
      .set({ session_version: sql`${users.session_version} + 1`, updated_at: Date.now() })
      .where(eq(users.id, user.id));
  return c.json({ ok: true });
});
auth.post('/change-password', async (c) => {
  const input = z
    .object({ currentPassword: z.string().max(1024), password: passwordInput })
    .parse(await c.req.json());
  const user = c.get('user');
  if (!(await checkPassword(input.currentPassword, user.password_hash)))
    throw new AppError(401, 'Current password is incorrect.');
  if (input.password === input.currentPassword)
    throw new AppError(422, 'Choose a different password.');
  const changes = {
    password_hash: await hashPassword(input.password),
    session_version: user.session_version + 1,
    must_change_password: false,
    password_changed_at: Date.now(),
    updated_at: Date.now(),
  };
  const updated = (
    await database(c.env.DB).update(users).set(changes).where(eq(users.id, user.id)).returning()
  )[0];
  setCookie(c, cookieName(c.env), await sessionToken(c.env, updated), {
    httpOnly: true,
    secure: c.env.LOCAL_MODE !== 'true',
    sameSite: 'Lax',
    path: '/',
    maxAge: 8 * 3600,
  });
  return c.json({ user: publicUser(updated) });
});
