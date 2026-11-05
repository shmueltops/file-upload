import { loadEnvironment, requireVariables } from './cloudflare-api';
loadEnvironment();
requireVariables('APP_ORIGIN');
const response = await fetch(`${process.env.APP_ORIGIN}/api/health`);
if (!response.ok || !((await response.json()) as { ok?: boolean }).ok)
  throw new Error('Published health check failed.');
console.log(`Healthy: ${process.env.APP_ORIGIN}`);
