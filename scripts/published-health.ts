type Options = {
  attempts?: number;
  retryDelayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (message: string) => void;
};

export async function checkPublishedSite(origin: string, options: Options = {}) {
  const {
    attempts = 12,
    retryDelayMs = 5000,
    fetcher = fetch,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    onRetry = console.warn,
  } = options;
  const base = origin.replace(/\/$/, '');
  const get = async (path: string) => {
    const url = `${base}${path}`;
    const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}.`);
    return response;
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await get('/api/health');
      const data = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (data?.ok !== true)
        throw new Error(`GET ${base}/api/health did not return JSON with ok: true.`);
      const page = await get('/');
      if (!(await page.text()).includes('href="/favicon.svg"'))
        throw new Error(`GET ${base}/ is missing the favicon link.`);
      const icon = await get('/favicon.svg');
      if (
        !icon.headers.get('Content-Type')?.includes('image/svg+xml') ||
        !(await icon.text()).includes('<svg')
      )
        throw new Error(`GET ${base}/favicon.svg is not an SVG (possibly the SPA fallback).`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt === attempts)
        throw new Error(`Published health check failed after ${attempts} attempts: ${reason}`);
      onRetry(
        `Published site not ready (${attempt}/${attempts}): ${reason} Retrying in ${retryDelayMs / 1000}s.`,
      );
      await sleep(retryDelayMs);
    }
  }
}
