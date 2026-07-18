import postgres, { type Sql } from 'postgres';
import { env } from '../config.js';
import { getBudgetControlDbPassword } from './credentials.js';
import {
  resolveBudgetControlDatabaseConfig,
  type BudgetControlDatabaseConfig,
} from './database-config.js';

let resolvedConfig: BudgetControlDatabaseConfig | undefined;
let rawClient: Sql | undefined;

function configSource(): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_ENV: env.NODE_ENV,
    DATABASE_URL: env.DATABASE_URL,
    DB_MASTER_USER_SECRET_ARN: env.DB_MASTER_USER_SECRET_ARN,
    BUDGET_CONTROL_DATABASE_URL: env.BUDGET_CONTROL_DATABASE_URL,
    BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN: env.BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN,
    ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: String(
      env.ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK,
    ),
  };
}

function getConfig(): BudgetControlDatabaseConfig {
  resolvedConfig ??= resolveBudgetControlDatabaseConfig(configSource());
  return resolvedConfig;
}

/** Raw dedicated pool. Production callers must obtain it through runtime-posture. */
export function getBudgetControlSql(): Sql {
  if (rawClient) return rawClient;
  const config = getConfig();
  const rotatingPassword = config.runtimeUserSecretArn
    ? {
        password: () =>
          getBudgetControlDbPassword(config.runtimeUserSecretArn!, config.expectedUsername),
      }
    : {};

  rawClient = postgres(config.databaseUrl, {
    max: 20,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    ...rotatingPassword,
  });
  return rawClient;
}

export function getBudgetControlClientMetadata(): Pick<
  BudgetControlDatabaseConfig,
  'expectedUsername' | 'source'
> {
  const config = getConfig();
  return { expectedUsername: config.expectedUsername, source: config.source };
}

export async function closeBudgetControlDb(): Promise<void> {
  const client = rawClient;
  rawClient = undefined;
  if (client) await client.end();
}

export function _resetBudgetControlClientForTests(): void {
  resolvedConfig = undefined;
  rawClient = undefined;
}
