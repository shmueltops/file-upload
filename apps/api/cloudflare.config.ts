import { bindings, defineConfig } from 'cf/config';
import { cloudflareEnvironment, observability } from '../../scripts/cloudflare-bindings.ts';
export default defineConfig({
  worker: {
    name: process.env.API_WORKER_NAME || 'file-vault',
    entrypoint: './src/index.ts',
    compatibilityDate: '2026-11-05',
    compatibilityFlags: ['nodejs_compat'],
    env: {
      ...cloudflareEnvironment(),
      ASSETS: bindings.assets(),
      LOGIN_LIMITER: bindings.rateLimit({ namespace: '1001', simple: { limit: 10, period: 60 } }),
    },
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: [
        '/api/*',
        '/auth/*',
        '/uploads/*',
        '/files/*',
        '/folders/*',
        '/admin/*',
        '/__local/*',
      ],
    },
    observability,
    limits: { cpuMs: 30_000 },
  },
});
