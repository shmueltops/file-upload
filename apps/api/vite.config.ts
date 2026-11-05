import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../web/public', import.meta.url)),
  plugins: [cloudflare(), react()],
  environments: {
    ssr: {
      resolve: { conditions: ['workerd', 'browser'], mainFields: ['browser', 'module', 'main'] },
    },
  },
  build: { outDir: fileURLToPath(new URL('../../.cloudflare/api', import.meta.url)) },
});
