import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { buildWorkers, root } from './build';
import { localRuntime, migrateLocal } from './runtime';
import { hashPassword } from '../packages/shared/src/services/users';

try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  /* Local configuration is optional. */
}
await mkdir(resolve(root, '.local'), { recursive: true });
let config: { secret: string; email: string; password: string };
try {
  config = JSON.parse(await readFile(resolve(root, '.local/admin.json'), 'utf8'));
} catch {
  config = {
    secret: crypto.randomUUID() + crypto.randomUUID(),
    email: process.env.ADMIN_EMAIL ?? 'admin@example.test',
    password: process.env.ADMIN_INITIAL_PASSWORD ?? crypto.randomUUID(),
  };
  await writeFile(resolve(root, '.local/admin.json'), JSON.stringify(config, null, 2));
}
await buildWorkers();
const mf = localRuntime(
  config.secret,
  true,
  8787,
  'http://127.0.0.1:5173',
  process.argv.includes('--test'),
);
await mf.ready;
const db = await migrateLocal(mf);
if (
  !(await db
    .prepare('SELECT id FROM users WHERE email_key=?')
    .bind(config.email.toLowerCase())
    .first())
) {
  await db
    .prepare(
      "INSERT INTO users(id,email,email_key,password_hash,role,must_change_password,created_at,updated_at) VALUES(?,?,?,?,'admin',1,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      config.email,
      config.email.toLowerCase(),
      await hashPassword(config.password),
      Date.now(),
      Date.now(),
    )
    .run();
}
const server = await createServer({ configFile: resolve(root, 'apps/web/vite.config.ts') });
await server.listen();
console.log(
  '\nFile Vault: http://127.0.0.1:5173\nLocal admin configuration: .local/admin.json (ignored by git).\nThe initial password must be changed on first sign-in.\n',
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await mf.dispose();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
