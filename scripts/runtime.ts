import { Miniflare } from 'miniflare';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './build';
export function localRuntime(
  secret: string,
  persist = true,
  port = 8787,
  appOrigin = 'http://127.0.0.1:5173',
) {
  const common = {
    modules: true,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'vault-db' },
    r2Buckets: { QUARANTINE: 'vault-quarantine', CLEAN: 'vault-clean' },
    queueProducers: { JOBS: 'vault-jobs' },
    bindings: {
      LOCAL_MODE: 'true',
      SESSION_SECRET: secret,
      APP_ORIGIN: appOrigin,
      QUARANTINE_BUCKET: 'vault-quarantine',
      CLEAN_BUCKET: 'vault-clean',
    },
  };
  return new Miniflare({
    host: '127.0.0.1',
    port,
    ...(persist
      ? {
          d1Persist: resolve(root, '.local/d1'),
          r2Persist: resolve(root, '.local/r2'),
          queuePersist: resolve(root, '.local/queues'),
        }
      : {}),
    workers: [
      { ...common, name: 'vault-api', scriptPath: resolve(root, 'dist/api.js') },
      {
        ...common,
        name: 'vault-consumer',
        scriptPath: resolve(root, 'dist/queue-consumer.js'),
        queueConsumers: {
          'vault-jobs': {
            maxBatchSize: 5,
            maxBatchTimeout: 1,
            maxRetries: 10,
            retryDelay: 10,
            deadLetterQueue: 'vault-dlq',
          },
        },
      },
    ],
  });
}
export async function migrateLocal(mf: Miniflare) {
  const db = await mf.getD1Database('DB', 'vault-api');
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    )
    .run();
  const migrations = (await readdir(resolve(root, 'packages/shared/migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const name of migrations) {
    if (await db.prepare('SELECT id FROM d1_migrations WHERE id=?').bind(name).first()) continue;
    const sql = await readFile(resolve(root, 'packages/shared/migrations', name), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch([
      ...statements.map((s) => db.prepare(s)),
      db.prepare('INSERT INTO d1_migrations(id,applied_at) VALUES(?,?)').bind(name, Date.now()),
    ]);
  }
  return db;
}
