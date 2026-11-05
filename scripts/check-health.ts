import { loadEnvironment, requireVariables } from './cloudflare-api';
import { checkPublishedSite } from './published-health';
loadEnvironment();
requireVariables('APP_ORIGIN');
await checkPublishedSite(process.env.APP_ORIGIN!);
console.log(`Healthy: ${process.env.APP_ORIGIN}`);
