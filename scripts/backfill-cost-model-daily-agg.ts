import { createClient } from '@clickhouse/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_TABLE = 'cost_model_daily_agg';
const STATUS_TABLE = 'cost_model_daily_agg_backfill_status';
const CONFIRM_INGEST_PAUSED_ENV = 'CONFIRM_COST_EVENTS_INGEST_PAUSED';

interface ClickHouseCommand {
  query: string;
  query_params?: Record<string, unknown>;
  clickhouse_settings?: Record<string, unknown>;
}

interface ClickHouseQuery {
  query: string;
  query_params?: Record<string, unknown>;
  format: 'JSONEachRow';
}

interface ClickHouseJsonResult {
  json(): Promise<unknown>;
}

interface ClickHouseCommandClient {
  command(input: ClickHouseCommand): Promise<unknown>;
  query(input: ClickHouseQuery): Promise<ClickHouseJsonResult>;
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

interface AggregateTotals {
  cost_usd: string;
  tokens_in: string;
  tokens_out: string;
  call_count: string;
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
      is_demo,
      provider,
      model,
      CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)') AS total_cost_usd,
      sum(tokens_in) AS total_tokens_in,
      sum(tokens_out) AS total_tokens_out,
      count() AS call_count,
      max(billing_retention_days) AS billing_retention_days
    FROM cost_events
    ${whereClause}
    GROUP BY day, builder_id, is_demo, provider, model
  `;
}

function sourceTotalsQuery(whereClause: string): string {
  return `
    SELECT
      toString(CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)')) AS cost_usd,
      toString(sum(tokens_in)) AS tokens_in,
      toString(sum(tokens_out)) AS tokens_out,
      toString(count()) AS call_count
    FROM cost_events
    ${whereClause}
  `;
}

function aggregateTotalsQuery(whereClause: string): string {
  return `
    SELECT
      toString(CAST(sum(total_cost_usd), 'Decimal(38,6)')) AS cost_usd,
      toString(sum(total_tokens_in)) AS tokens_in,
      toString(sum(total_tokens_out)) AS tokens_out,
      toString(sum(call_count)) AS call_count
    FROM ${TARGET_TABLE}
    ${whereClause}
  `;
}

function normalizeDecimal(value: unknown): string {
  const raw = String(value ?? '0');
  const [integer, fraction = ''] = raw.split('.');
  return `${integer || '0'}.${fraction.padEnd(6, '0').slice(0, 6)}`;
}

function normalizeUInt(value: unknown): string {
  return String(value ?? '0');
}

async function queryTotals(
  client: ClickHouseCommandClient,
  query: string,
  queryParams?: Record<string, unknown>,
): Promise<AggregateTotals> {
  const result = await client.query({
    query,
    ...(queryParams ? { query_params: queryParams } : {}),
    format: 'JSONEachRow',
  });
  const [row] = (await result.json()) as Array<Partial<AggregateTotals>>;

  return {
    cost_usd: normalizeDecimal(row?.cost_usd),
    tokens_in: normalizeUInt(row?.tokens_in),
    tokens_out: normalizeUInt(row?.tokens_out),
    call_count: normalizeUInt(row?.call_count),
  };
}

async function latestAggregateTrusted(client: ClickHouseCommandClient): Promise<boolean> {
  const result = await client.query({
    query: `
      SELECT status
      FROM ${STATUS_TABLE}
      ORDER BY checked_at DESC
      LIMIT 1
    `,
    format: 'JSONEachRow',
  });
  const [row] = (await result.json()) as Array<{ status?: string }>;
  return row?.status === 'trusted';
}

function statusInsertQuery(day: string | null): string {
  const dayExpr = day ? 'toDate({day:String})' : 'CAST(NULL AS Nullable(Date))';
  return `
    INSERT INTO ${STATUS_TABLE}
      (checked_at, scope, status, reason, day,
       source_cost_usd, aggregate_cost_usd,
       source_tokens_in, aggregate_tokens_in,
       source_tokens_out, aggregate_tokens_out,
       source_call_count, aggregate_call_count)
    SELECT
      now64(6),
      {scope:String},
      {status:String},
      {reason:String},
      ${dayExpr},
      toDecimal128({source_cost_usd:String}, 6),
      toDecimal128({aggregate_cost_usd:String}, 6),
      toUInt64({source_tokens_in:String}),
      toUInt64({aggregate_tokens_in:String}),
      toUInt64({source_tokens_out:String}),
      toUInt64({aggregate_tokens_out:String}),
      toUInt64({source_call_count:String}),
      toUInt64({aggregate_call_count:String})
  `;
}

async function writeBackfillStatus(
  client: ClickHouseCommandClient,
  input: {
    scope: 'full' | 'day';
    status: 'trusted' | 'untrusted';
    reason: string;
    day: string | null;
    source?: AggregateTotals;
    aggregate?: AggregateTotals;
  },
): Promise<void> {
  const emptyTotals: AggregateTotals = {
    cost_usd: '0.000000',
    tokens_in: '0',
    tokens_out: '0',
    call_count: '0',
  };
  const source = input.source ?? emptyTotals;
  const aggregate = input.aggregate ?? emptyTotals;

  await client.command({
    query: statusInsertQuery(input.day),
    query_params: {
      scope: input.scope,
      status: input.status,
      reason: input.reason,
      ...(input.day ? { day: input.day } : {}),
      source_cost_usd: source.cost_usd,
      aggregate_cost_usd: aggregate.cost_usd,
      source_tokens_in: source.tokens_in,
      aggregate_tokens_in: aggregate.tokens_in,
      source_tokens_out: source.tokens_out,
      aggregate_tokens_out: aggregate.tokens_out,
      source_call_count: source.call_count,
      aggregate_call_count: aggregate.call_count,
    },
  });
}

function totalsMatch(source: AggregateTotals, aggregate: AggregateTotals): boolean {
  return (
    source.cost_usd === aggregate.cost_usd &&
    source.tokens_in === aggregate.tokens_in &&
    source.tokens_out === aggregate.tokens_out &&
    source.call_count === aggregate.call_count
  );
}

function totalsMismatchMessage(source: AggregateTotals, aggregate: AggregateTotals): string {
  return (
    `${TARGET_TABLE} verification failed: ` +
    `source=${JSON.stringify(source)} aggregate=${JSON.stringify(aggregate)}`
  );
}

async function verifyAggregate(
  client: ClickHouseCommandClient,
  day: string | null,
): Promise<{ source: AggregateTotals; aggregate: AggregateTotals }> {
  const sourceWhere = day ? 'WHERE toDate(timestamp) = toDate({day:String})' : '';
  const aggregateWhere = day ? 'WHERE day = toDate({day:String})' : '';
  const queryParams = day ? { day } : undefined;
  const [source, aggregate] = await Promise.all([
    queryTotals(client, sourceTotalsQuery(sourceWhere), queryParams),
    queryTotals(client, aggregateTotalsQuery(aggregateWhere), queryParams),
  ]);
  return { source, aggregate };
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
    const scope = day ? 'day' : 'full';
    const wasTrustedBeforeDayBackfill = day ? await latestAggregateTrusted(client) : false;
    await writeBackfillStatus(client, {
      scope,
      status: 'untrusted',
      reason: `${scope}_backfill_started`,
      day,
    });

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

    const { source, aggregate } = await verifyAggregate(client, day);
    if (!totalsMatch(source, aggregate)) {
      await writeBackfillStatus(client, {
        scope,
        status: 'untrusted',
        reason: `${scope}_backfill_verification_failed`,
        day,
        source,
        aggregate,
      });
      throw new Error(totalsMismatchMessage(source, aggregate));
    }

    const trusted = !day || wasTrustedBeforeDayBackfill;
    await writeBackfillStatus(client, {
      scope,
      status: trusted ? 'trusted' : 'untrusted',
      reason: trusted
        ? `${scope}_backfill_verified`
        : 'day_backfill_verified_but_full_backfill_untrusted',
      day,
      source,
      aggregate,
    });
    stdout.log(`Backfilled ${TARGET_TABLE} for ${day ?? 'all cost_events'}`);
  } finally {
    await client.close();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(
      'model daily aggregate backfill failed:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
