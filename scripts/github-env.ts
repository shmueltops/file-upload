import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { root } from './build';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const repository = option('--repo');
const environment = option('--environment');
if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw new Error('Use --repo OWNER/REPOSITORY.');
if (environment && !/^[A-Za-z0-9_.-]+$/.test(environment))
  throw new Error('Use a simple GitHub environment name.');
const values = parseEnv(await readFile(resolve(root, '.env'), 'utf8'));
const secrets = new Set([
  'CLOUDFLARE_API_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'SESSION_SECRET',
  'ADMIN_INITIAL_PASSWORD',
]);
const variables = new Set([
  'ADMIN_EMAIL',
  'CLOUDFLARE_ACCOUNT_ID',
  'D1_DATABASE_ID',
  'D1_DATABASE_NAME',
  'APP_ORIGIN',
  'R2_ENDPOINT',
  'QUARANTINE_BUCKET',
  'CLEAN_BUCKET',
  'PROCESSING_QUEUE',
  'DEAD_LETTER_QUEUE',
  'API_WORKER_NAME',
  'CONSUMER_WORKER_NAME',
]);
const invoke = (command: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('gh', command, {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`GitHub CLI failed: ${errors.trim() || `exit ${code}`}`)),
    );
    child.stdin.end(input);
  });
let target = repository;
if (!dryRun) {
  await invoke(['auth', 'status']);
  target ??= await invoke(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
}
const destination = target ?? '(repository selected from Git remote when run)';
console.log(
  `${dryRun ? 'Preview' : 'Configure'} ${destination}${environment ? `, environment ${environment}` : ', repository settings'}.`,
);
for (const [key, value] of Object.entries(values)) {
  if (!value || (!secrets.has(key) && !variables.has(key))) continue;
  const kind = secrets.has(key) ? 'secret' : 'variable';
  if (!dryRun)
    await invoke(
      [kind, 'set', key, '--repo', target!, ...(environment ? ['--env', environment] : [])],
      value,
    );
  console.log(`${dryRun ? 'Would set' : 'Set'} ${kind}: ${key}`);
}
console.log(
  dryRun
    ? 'No GitHub settings were changed; no values were printed.'
    : 'GitHub configuration synchronized. Values were provided through stdin and were not printed.',
);
