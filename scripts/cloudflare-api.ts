import { resolve } from 'node:path';
import { root } from './build';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { setDefaultResultOrder } from 'node:dns';
export function loadEnvironment() {
  setDefaultResultOrder('ipv4first');
  try {
    const file = parseEnv(readFileSync(resolve(root, '.env'), 'utf8'));
    for (const [key, value] of Object.entries(file))
      if (!process.env[key]) process.env[key] = value;
  } catch {
    /* CI supplies environment directly. */
  }
}
export function requireVariables(...names: string[]) {
  for (const name of names)
    if (!process.env[name])
      throw new Error(`Set ${name} in the ignored .env or process environment.`);
}
export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}
export async function cloudflare<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  requireVariables('CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN');
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as {
    success: boolean;
    result: T;
    errors?: { code: number; message: string }[];
  };
  if (!response.ok || !data.success)
    throw new CloudflareApiError(
      `Cloudflare ${method} ${path} failed (${response.status}): ${data.errors?.map((e) => e.message).join('; ') ?? 'unknown error'}`,
      response.status,
      data.errors?.map((e) => e.code) ?? [],
    );
  return data.result;
}
