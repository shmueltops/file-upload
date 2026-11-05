export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = (await response.json()) as { error?: string; code?: string };
  if (!response.ok)
    throw new ApiError(response.status, data.error ?? 'The request failed.', data.code);
  return data as T;
}
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export const bytes = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(2)} GB`
    : n >= 1_048_576
      ? `${(n / 1_048_576).toFixed(1)} MiB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${n} B`;
export const date = (n?: number | null) => (n ? new Date(n).toLocaleString() : '—');
export const changed = () => window.dispatchEvent(new Event('vault:changed'));
export function timeRemaining(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Calculating time remaining…';
  const total = Math.max(1, Math.ceil(seconds));
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
  if (total < 60) return `${unit(total, 'second')} left`;
  if (total < 3600)
    return `${unit(Math.floor(total / 60), 'minute')}${total % 60 ? ` ${unit(total % 60, 'second')}` : ''} left`;
  const minutes = Math.floor((total % 3600) / 60);
  return `${unit(Math.floor(total / 3600), 'hour')}${minutes ? ` ${unit(minutes, 'minute')}` : ''} left`;
}
