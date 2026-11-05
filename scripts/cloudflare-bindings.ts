import { bindings } from 'cf/config';
import type { WorkMessage } from '../packages/shared/src/contracts';
export const cloudflareEnvironment = () => ({
  DB: bindings.d1({
    id: process.env.D1_DATABASE_ID || undefined,
    name: process.env.D1_DATABASE_NAME || 'file-vault',
  }),
  QUARANTINE: bindings.r2({ name: process.env.QUARANTINE_BUCKET || 'file-vault-quarantine' }),
  CLEAN: bindings.r2({ name: process.env.CLEAN_BUCKET || 'file-vault-clean' }),
  JOBS: bindings.queue<WorkMessage>({
    name: process.env.PROCESSING_QUEUE || 'file-vault-processing',
  }),
  SESSION_SECRET: bindings.secret(),
  R2_ACCESS_KEY_ID: bindings.secret(),
  R2_SECRET_ACCESS_KEY: bindings.secret(),
  APP_ORIGIN: bindings.text(process.env.APP_ORIGIN || 'http://127.0.0.1:5173'),
  R2_ENDPOINT: bindings.text(
    process.env.R2_ENDPOINT ||
      `https://${process.env.CLOUDFLARE_ACCOUNT_ID || 'ACCOUNT_ID'}.r2.cloudflarestorage.com`,
  ),
  QUARANTINE_BUCKET: bindings.text(process.env.QUARANTINE_BUCKET || 'file-vault-quarantine'),
  CLEAN_BUCKET: bindings.text(process.env.CLEAN_BUCKET || 'file-vault-clean'),
});
export const observability = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true },
  traces: { enabled: true, headSamplingRate: 0.1 },
};
