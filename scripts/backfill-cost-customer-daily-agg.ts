import { createClient } from '@clickhouse/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_TABLE = 'cost_customer_daily_agg';
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
      is_demo,
      CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)') AS total_cost_usd,
      count() AS event_count,
      max(timestamp) AS last_seen_at,
      max(billing_retention_days) AS billing_retention_days
    FROM cost_events
    ${whereClause}
    GROUP BY day, builder_id, customer_id, is_demo
  `;
}

function requireIngestPaused(env: BackfillEnv): void {
  if (env[CONFIRM_INGEST_PAUSED_ENV] === 'true') return;
  throw new Error(
    `Refusing to backfill ${TARGET_TABLE} while cost_events ingest may be active. ` +
      `Pause telemetry ingest, then set ${CONFIRM_INGEST_PAUSED_ENV}=true.`,
  );
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

  const url = env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
  const day = dayArg(argv);
  const clientFactory =
    options.clientFactory ?? (createClient as unknown as ClickHouseClientFactory);
  const client = clientFactory({ url });

  try {
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
    } else {
      await client.command({ query: `TRUNCATE TABLE ${TARGET_TABLE}` });
      await client.command({ query: insertQuery('') });
    }
    stdout.log(`Backfilled ${TARGET_TABLE} for ${day ?? 'all cost_events'}`);
  } finally {
    await client.close();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(
      'customer daily aggregate backfill failed:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
