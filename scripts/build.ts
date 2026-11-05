import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildWorkers() {
  await Promise.all(
    ['api', 'queue-consumer'].map((name) =>
      build({
        entryPoints: [resolve(root, `apps/${name}/src/index.ts`)],
        outfile: resolve(root, `dist/${name}.js`),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        conditions: ['workerd', 'worker', 'browser'],
        external: ['cloudflare:*', 'node:*'],
        sourcemap: true,
      }),
    ),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWorkers();
  await viteBuild({ configFile: resolve(root, 'apps/web/vite.config.ts') });
}
