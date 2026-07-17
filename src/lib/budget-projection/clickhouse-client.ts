import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { env } from '../config.js';
import {
  BUDGET_PROJECTION_CLICKHOUSE_ROLE,
  GENERAL_CLICKHOUSE_APP_ROLE,
  resolveBudgetProjectionClickHouseConfig,
  type BudgetProjectionClickHouseConfig,
} from './clickhouse-config.js';

let resolvedConfig: BudgetProjectionClickHouseConfig | undefined;
let rawClient: ClickHouseClient | undefined;

function configSource(): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_ENV: env.NODE_ENV,
    CLICKHOUSE_URL: env.CLICKHOUSE_URL,
    BUDGET_PROJECTION_CLICKHOUSE_URL: env.BUDGET_PROJECTION_CLICKHOUSE_URL,
    ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK: String(
      env.ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK,
    ),
  };
}

function getConfig(): BudgetProjectionClickHouseConfig {
  resolvedConfig ??= resolveBudgetProjectionClickHouseConfig(configSource());
  return resolvedConfig;
}

/** Raw dedicated client. Production callers obtain it through clickhouse-posture. */
export function getBudgetProjectionClickHouseClient(): ClickHouseClient {
  if (rawClient) return rawClient;
  const config = getConfig();
  rawClient = createClient({
    url: config.connectionUrl,
    application: 'pylva-authoritative-budget-projector',
    keep_alive: { enabled: true, idle_socket_ttl: 2_500 },
    request_timeout: 30_000,
  });
  return rawClient;
}

export function getBudgetProjectionClickHouseClientMetadata(): Pick<
  BudgetProjectionClickHouseConfig,
  'database' | 'expectedGeneralUsername' | 'expectedProjectorUsername' | 'source'
> & {
  expectedGeneralRole: typeof GENERAL_CLICKHOUSE_APP_ROLE;
  expectedProjectorRole: typeof BUDGET_PROJECTION_CLICKHOUSE_ROLE;
} {
  const config = getConfig();
  return {
    database: config.database,
    expectedGeneralRole: GENERAL_CLICKHOUSE_APP_ROLE,
    expectedGeneralUsername: config.expectedGeneralUsername,
    expectedProjectorRole: BUDGET_PROJECTION_CLICKHOUSE_ROLE,
    expectedProjectorUsername: config.expectedProjectorUsername,
    source: config.source,
  };
}

export async function closeBudgetProjectionClickHouse(): Promise<void> {
  const client = rawClient;
  rawClient = undefined;
  if (client) await client.close();
}

export function _resetBudgetProjectionClickHouseClientForTests(): void {
  resolvedConfig = undefined;
  rawClient = undefined;
}
