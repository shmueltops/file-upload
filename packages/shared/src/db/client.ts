import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
export const database = (binding: D1Database) => drizzle(binding, { schema });
export async function first<T>(db: D1Database, query: string, ...params: unknown[]) {
  return db
    .prepare(query)
    .bind(...params)
    .first<T>();
}
export async function all<T>(db: D1Database, query: string, ...params: unknown[]) {
  return (
    await db
      .prepare(query)
      .bind(...params)
      .all<T>()
  ).results;
}
export async function run(db: D1Database, query: string, ...params: unknown[]) {
  return db
    .prepare(query)
    .bind(...params)
    .run();
}
