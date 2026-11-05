import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const files = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const env = await readFile('.env', 'utf8')
  .then(parseEnv)
  .catch(() => ({}) as Record<string, string>);
const protectedNames = [
  'CLOUDFLARE_API_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'SESSION_SECRET',
  'ADMIN_INITIAL_PASSWORD',
];
const secretValues = protectedNames
  .map((name) => env[name])
  .filter((value): value is string => !!value && value.length >= 8);
const problems: string[] = [];
for (const path of files) {
  if (/(^|\/)(\.env(?:\..*)?|\.dev\.vars.*)$/.test(path) && path !== '.env.example')
    problems.push(`Sensitive configuration file: ${path}`);
  if (
    /(^|\/)(node_modules|\.local|\.cloudflare|\.wrangler|artifacts|test-results|playwright-report|coverage|dist)\//.test(
      path,
    )
  )
    problems.push(`Generated/runtime file: ${path}`);
  const contents = execFileSync('git', ['show', `:${path}`], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  if (secretValues.some((value) => contents.includes(value)))
    problems.push(`A configured secret value is present in ${path}`);
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{30,}/.test(contents)
  )
    problems.push(`Possible private key/token in ${path}`);
}
if (problems.length) throw new Error(problems.join('\n'));
console.log(
  `Checked ${files.length} indexed files: no ignored runtime paths or configured secret values found.`,
);
