import { defineConfig, triggers } from 'cf/config';
import { cloudflareEnvironment, observability } from '../../scripts/cloudflare-bindings.ts';
export default defineConfig({
  worker: {
    name: process.env.CONSUMER_WORKER_NAME || 'file-vault-consumer',
    entrypoint: './src/index.ts',
    compatibilityDate: '2026-11-05',
    compatibilityFlags: ['nodejs_compat'],
    env: cloudflareEnvironment(),
    observability,
    limits: { cpuMs: 30_000 },
    triggers: [
      triggers.queue({
        name: process.env.PROCESSING_QUEUE || 'file-vault-processing',
        maxBatchSize: 5,
        maxBatchTimeout: 1,
        maxRetries: 10,
        retryDelay: 10,
        deadLetterQueue: process.env.DEAD_LETTER_QUEUE || 'file-vault-dead-letter',
      }),
    ],
  },
});
