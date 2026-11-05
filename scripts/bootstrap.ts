import { hashPassword } from '../packages/shared/src/services/users';
import { resolve } from 'node:path';
import { root } from './build';
import { loadEnvironment } from './cloudflare-api';
loadEnvironment();
const {
  ADMIN_EMAIL: email,
  ADMIN_INITIAL_PASSWORD: password,
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: account,
  D1_DATABASE_ID: id,
} = process.env;
if (!email || !password || !token || !account || !id)
  throw new Error(
    'Set ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID in the ignored .env.',
  );
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sql: "INSERT INTO users(id,email,email_key,password_hash,role,must_change_password,created_at,updated_at) VALUES(?,?,?,?,'admin',1,?,?) ON CONFLICT(email_key) DO NOTHING",
      params: [
        crypto.randomUUID(),
        email.trim(),
        email.trim().toLowerCase(),
        await hashPassword(password),
        Date.now(),
        Date.now(),
      ],
    }),
  },
);
if (!response.ok)
  throw new Error(
    `Admin bootstrap failed with HTTP ${response.status}. Check D1 permissions and migration status.`,
  );
const result = (await response.json()) as { success: boolean };
if (!result.success) throw new Error('D1 rejected the bootstrap. Check schema and logs.');
console.log(
  'Admin bootstrap complete. An existing admin was not reset. First-login password change is required.',
);
