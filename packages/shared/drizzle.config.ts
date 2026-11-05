import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/shared/src/db/schema.ts',
  out: './packages/shared/migrations',
});
