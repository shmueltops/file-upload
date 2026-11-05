import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
export default defineConfig({
  plugins: [cloudflare()],
  environments: {
    ssr: {
      resolve: { conditions: ['workerd', 'browser'], mainFields: ['browser', 'module', 'main'] },
    },
  },
  build: { outDir: '../../.cloudflare/consumer' },
});
