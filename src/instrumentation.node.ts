import { registerBatcherShutdown } from './lib/alerts/batcher.integration.js';
import { initApiKeyRevocationListener } from './lib/auth/api-key.js';
import { validateProductionSecrets } from './lib/config-guards.js';
import { logger } from './lib/logger.js';
import { connectRedis } from './lib/redis/client.js';

let runtimeBootstrapPromise: Promise<void> | null = null;

async function runBootstrap(): Promise<void> {
  // Fail fast before anything else if production secrets are weak/default.
  validateProductionSecrets();
  registerBatcherShutdown();
  await connectRedis();
  await initApiKeyRevocationListener();
  logger.info({ module: 'runtime.bootstrap' }, 'runtime bootstrap complete');
}

export function bootstrapNodeRuntime(): Promise<void> {
  if (runtimeBootstrapPromise) return runtimeBootstrapPromise;
  const p = runBootstrap().catch((err) => {
    runtimeBootstrapPromise = null;
    throw err;
  });
  runtimeBootstrapPromise = p;
  return p;
}
