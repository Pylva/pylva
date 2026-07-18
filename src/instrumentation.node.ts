import { registerBatcherShutdown } from './lib/alerts/batcher.integration.js';
import { initApiKeyRevocationListener } from './lib/auth/api-key.js';
import { validateProductionSecrets } from './lib/config-guards.js';
import { assertBudgetControlRuntimeReadyForProduction } from './lib/budget-control/runtime-posture.js';
import { assertBudgetProjectionClickHouseReadyForProduction } from './lib/budget-projection/clickhouse-posture.js';
import { assertGeneralAppRuntimeReadyForProduction } from './lib/db/general-app-runtime-posture.js';
import { logger } from './lib/logger.js';
import { connectRedis } from './lib/redis/client.js';

let runtimeBootstrapPromise: Promise<void> | null = null;

async function runBootstrap(): Promise<void> {
  // Fail fast before anything else if production secrets are weak/default.
  validateProductionSecrets();
  // Every production deployment must attest the general DATABASE_URL owner
  // boundary, its dedicated authoritative NOBYPASS role, and the isolated
  // ClickHouse projector before Redis/listeners or any request-serving side
  // effect starts. Rule mutations and existing lifecycle work still use these
  // identities while new reservations are disabled.
  await assertGeneralAppRuntimeReadyForProduction();
  await assertBudgetControlRuntimeReadyForProduction();
  await assertBudgetProjectionClickHouseReadyForProduction();
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
