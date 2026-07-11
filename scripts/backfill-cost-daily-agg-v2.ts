import { createClient } from '@clickhouse/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitClickHouseStatements } from '../db/clickhouse-statements.js';

const TARGET_TABLE = 'cost_daily_agg_v2';
const MATERIALIZED_VIEW = 'cost_daily_agg_v2_mv';
const CONFIRM_INGEST_PAUSED_ENV = 'CONFIRM_COST_EVENTS_INGEST_PAUSED';

interface ClickHouseCommand {
  query: string;
  query_params?: Record<string, unknown>;
  clickhouse_settings?: Record<string, unknown>;
}

interface ClickHouseCommandClient {
  command(input: ClickHouseCommand): Promise<unknown>;
  close(): Promise<void>;
}

type ClickHouseClientFactory = (options: { url: string }) => ClickHouseCommandClient;
type BackfillEnv = Record<string, string | undefined>;

interface BackfillOptions {
  argv?: string[];
  env?: BackfillEnv;
  clientFactory?: ClickHouseClientFactory;
  ddlPath?: string;
  stdout?: Pick<typeof console, 'log'>;
}

function dayArg(argv: string[]): string | null {
  const raw = argv[2];
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error('Expected optional day argument in YYYY-MM-DD format');
  }
  return raw;
}

function insertQuery(whereClause: string): string {
  return `
    INSERT INTO ${TARGET_TABLE}
    SELECT
      toDate(timestamp) AS day,
      builder_id,
      customer_id,
      provider,
      model,
      step_name,
      billing_retention_days,
      sum(tokens_in) AS total_tokens_in,
      sum(tokens_out) AS total_tokens_out,
      sum(ifNull(cost_usd, toDecimal64(0, 6))) AS total_cost_usd,
      count() AS event_count,
      avg(latency_ms) AS avg_latency_ms
    FROM cost_events
    ${whereClause}
    GROUP BY builder_id, customer_id, day, provider, model, step_name, billing_retention_days
  `;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function defaultDdlPath(): string {
  return path.join(repoRoot(), 'db/clickhouse/008_cost_daily_agg_v2.sql');
}

function materializedViewCreateStatement(ddlPath = defaultDdlPath()): string {
  const ddl = fs.readFileSync(ddlPath, 'utf8');
  const statement = splitClickHouseStatements(ddl).find((sql) =>
    sql.includes(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${MATERIALIZED_VIEW}`),
  );
  if (!statement) {
    throw new Error(`Could not find ${MATERIALIZED_VIEW} CREATE statement in ${ddlPath}`);
  }
  return statement.trim().endsWith(';') ? statement.trim() : `${statement.trim()};`;
}

function requireIngestPaused(env: BackfillEnv): void {
  if (env[CONFIRM_INGEST_PAUSED_ENV] === 'true') return;
  throw new Error(
    `Refusing to backfill ${TARGET_TABLE} while cost_events ingest may be active. ` +
      `Pause telemetry ingest, then set ${CONFIRM_INGEST_PAUSED_ENV}=true.`,
  );
}

async function withMaterializedViewDropped(
  client: ClickHouseCommandClient,
  createViewStatement: string,
  action: () => Promise<void>,
): Promise<void> {
  await client.command({ query: `DROP VIEW IF EXISTS ${MATERIALIZED_VIEW} SYNC` });
  let actionError: unknown;

  try {
    await action();
  } catch (err) {
    actionError = err;
    throw err;
  } finally {
    try {
      await client.command({ query: createViewStatement });
    } catch (restoreError) {
      if (actionError) {
        throw new AggregateError(
          [actionError, restoreError],
          `Backfill failed and ${MATERIALIZED_VIEW} could not be recreated`,
        );
      }
      throw restoreError;
    }
  }
}

function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  return fileURLToPath(importMetaUrl) === path.resolve(argvPath);
}

export async function main(options: BackfillOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const stdout = options.stdout ?? console;

  requireIngestPaused(env);
  const createViewStatement = materializedViewCreateStatement(options.ddlPath);

  const url = env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
  const day = dayArg(argv);
  const clientFactory =
    options.clientFactory ?? (createClient as unknown as ClickHouseClientFactory);
  const client = clientFactory({ url });

  try {
    await withMaterializedViewDropped(client, createViewStatement, async () => {
      if (day) {
        await client.command({
          query: `ALTER TABLE ${TARGET_TABLE} DELETE WHERE day = toDate({day:String})`,
          query_params: { day },
          clickhouse_settings: { mutations_sync: '1' },
        });
        await client.command({
          query: insertQuery('WHERE toDate(timestamp) = toDate({day:String})'),
          query_params: { day },
        });
        return;
      }

      await client.command({ query: `TRUNCATE TABLE ${TARGET_TABLE}` });
      await client.command({ query: insertQuery('') });
    });
    stdout.log(`Backfilled ${TARGET_TABLE} for ${day ?? 'all cost_events'}`);
  } finally {
    await client.close();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error('daily aggregate v2 backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
