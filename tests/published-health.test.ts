import { expect, it, vi } from 'vitest';
import { checkPublishedSite } from '../scripts/published-health';

const origin = 'https://vault.test.invalid';
const healthy = (url: string | URL | Request) => {
  if (String(url).endsWith('/api/health')) return Response.json({ ok: true });
  if (String(url).endsWith('/favicon.svg'))
    return new Response('<svg></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
  return new Response('<link rel="icon" href="/favicon.svg">');
};
it('waits for a newly deployed hostname instead of failing on its first 404', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('Not ready', { status: 404 }))
    .mockImplementation(async (url) => healthy(url));
  const sleep = vi.fn().mockResolvedValue(undefined);
  const onRetry = vi.fn();
  await checkPublishedSite(origin, { fetcher, sleep, onRetry });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(onRetry).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
  expect(sleep).toHaveBeenCalledWith(5000);
});
it('keeps genuine health failures visible with the failing URL and status', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async () => new Response('Unavailable', { status: 503 }));
  const sleep = vi.fn().mockResolvedValue(undefined);
  await expect(
    checkPublishedSite(origin, { attempts: 2, fetcher, sleep, onRetry: () => {} }),
  ).rejects.toThrow(
    `Published health check failed after 2 attempts: GET ${origin}/api/health returned HTTP 503.`,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledTimes(1);
});
it('rejects HTML masquerading as the favicon even when all HTTP responses are 200', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (url) =>
      String(url).endsWith('/favicon.svg')
        ? new Response('<html>SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } })
        : healthy(url),
    );
  await expect(checkPublishedSite(origin, { attempts: 1, fetcher })).rejects.toThrow(
    'is not an SVG',
  );
});
