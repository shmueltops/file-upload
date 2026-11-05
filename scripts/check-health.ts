import { loadEnvironment, requireVariables } from './cloudflare-api';
loadEnvironment();
requireVariables('APP_ORIGIN');
const response = await fetch(`${process.env.APP_ORIGIN}/api/health`);
if (!response.ok || !((await response.json()) as { ok?: boolean }).ok)
  throw new Error('Published health check failed.');
const page = await fetch(`${process.env.APP_ORIGIN}/`);
if (!page.ok || !(await page.text()).includes('href="/favicon.svg"'))
  throw new Error('Published page is missing the favicon link.');
const icon = await fetch(`${process.env.APP_ORIGIN}/favicon.svg`);
if (
  !icon.ok ||
  !icon.headers.get('Content-Type')?.includes('image/svg+xml') ||
  !(await icon.text()).includes('<svg')
)
  throw new Error('Published favicon is missing or returning the SPA fallback.');
console.log(`Healthy: ${process.env.APP_ORIGIN}`);
