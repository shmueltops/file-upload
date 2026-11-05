import { argon2idAsync } from '@noble/hashes/argon2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { database } from '../db/client';
import { users, type StoredUser } from '../db/schema';
import { AppError, type ServiceBindings } from './types';

const encoder = new TextEncoder();
export async function hashPassword(
  password: string,
  salt = crypto.getRandomValues(new Uint8Array(16)),
) {
  const hash = await argon2idAsync(encoder.encode(password), salt, {
    m: 19456,
    t: 2,
    p: 1,
    dkLen: 32,
    asyncTick: 10,
  });
  return `argon2id$19456$2$1$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}
export async function checkPassword(password: string, stored: string) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'argon2id') return false;
  const computed = await hashPassword(password, hexToBytes(parts[4]));
  // Fixed-size digest comparison, independent of the position of a mismatch.
  const a = encoder.encode(computed),
    b = encoder.encode(stored);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}
export const emailKey = (email: string) => email.trim().toLowerCase();
export const publicUser = (u: StoredUser) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  must_change_password: u.must_change_password,
});
export async function createUser(
  env: ServiceBindings,
  email: string,
  password: string,
  role: 'user' | 'admin' = 'user',
) {
  const now = Date.now(),
    id = crypto.randomUUID();
  const hash = await hashPassword(password);
  try {
    await database(env.DB)
      .insert(users)
      .values({
        id,
        email: email.trim(),
        email_key: emailKey(email),
        password_hash: hash,
        role,
        created_at: now,
        updated_at: now,
      });
  } catch (e) {
    if (String(e).includes('UNIQUE'))
      throw new AppError(409, 'An account with that email already exists.');
    throw e;
  }
  return publicUser((await database(env.DB).select().from(users).where(eq(users.id, id)))[0]);
}
export async function sessionToken(env: ServiceBindings, u: StoredUser) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  return new SignJWT({ version: u.session_version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(u.id)
    .setAudience('file-vault')
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(encoder.encode(env.SESSION_SECRET));
}
export async function sessionUser(env: ServiceBindings, token?: string) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, encoder.encode(env.SESSION_SECRET), {
      algorithms: ['HS256'],
      audience: 'file-vault',
    });
    const u = (
      await database(env.DB)
        .select()
        .from(users)
        .where(eq(users.id, payload.sub ?? ''))
    )[0];
    return u && u.session_version === payload.version ? u : null;
  } catch {
    return null;
  }
}
