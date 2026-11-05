import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './build';
import { loadEnvironment, requireVariables } from './cloudflare-api';
loadEnvironment();
requireVariables(
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'D1_DATABASE_ID',
  'APP_ORIGIN',
  'SESSION_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
);
if (process.env.SESSION_SECRET!.length < 32)
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
const cf = resolve(root, 'node_modules/cf/bin/cf');
const invoke = (args: string[], cwd = root) =>
  new Promise<void>((ok, fail) => {
    const child = spawn(process.execPath, [cf, ...args], {
      cwd,
      env: { ...process.env, CLOUDFLARE_SEND_METRICS: 'false' },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`Cloudflare command failed with exit code ${code}.`)),
    );
  });
await mkdir(resolve(root, '.local'), { recursive: true });
const secretsFile = resolve(root, '.local/deploy-secrets.json');
await writeFile(
  secretsFile,
  JSON.stringify({
    SESSION_SECRET: process.env.SESSION_SECRET,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  }),
);
await invoke([
  'd1',
  'migrations',
  'apply',
  process.env.D1_DATABASE_ID!,
  '--dir',
  'packages/shared/migrations',
]);
await invoke(['deploy', '--secrets-file', secretsFile], resolve(root, 'apps/queue-consumer'));
await invoke(['deploy', '--secrets-file', secretsFile], resolve(root, 'apps/api'));
console.log(
  `Deployment complete: ${process.env.APP_ORIGIN}. Run pnpm bootstrap once to seed the administrator.`,
);
