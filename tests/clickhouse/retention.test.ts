import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@clickhouse/client';
import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';
import { chTimestamp } from '../../src/lib/clickhouse/datetime.js';

const CLICKHOUSE_URL = process.env['CLICKHOUSE_URL'];
// Opt-in gate: ci-fast exports CLICKHOUSE_URL globally without a ClickHouse
// service, so URL presence alone cannot mean "a live server is reachable".
// ci-integration (real 24.8 service) and local runs set CLICKHOUSE_LIVE_TESTS.
const describeClickHouse =
  CLICKHOUSE_URL && process.env['CLICKHOUSE_LIVE_TESTS'] === 'true' ? describe : describe.skip;
const BUILDER_ID = `retention-test-${crypto.randomBytes(6).toString('hex')}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function requiredClickHouseUrl(): string {
  if (!CLICKHOUSE_URL) throw new Error('CLICKHOUSE_URL is required for this suite');
  return CLICKHOUSE_URL;
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: chTimestamp(new Date('2026-04-18T10:00:00.000Z')),
    builder_id: BUILDER_ID,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    customer_id: `${BUILDER_ID}:cust_1`,
    provider: 'other',
    model: null,
    operation: 'reported',
    step_name: 'integration',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 1.23,
    pricing_status: 'priced',
    latency_ms: 12,
    status: 'success',
    cost_source: 'configured',
    instrumentation_tier: 'reported',
    metric: 'search_query',
    metric_value: 1,
    stream_aborted: 0,
    abort_savings: 0,
    metadata: '{}',
    ...overrides,
  };
}

describeClickHouse('cost_events per-row retention columns', () => {
  let client: ReturnType<typeof createClient> | null = null;

  beforeAll(() => {
    client = createClient({ url: requiredClickHouseUrl() });
  });

  afterAll(async () => {
    if (!client) return;
    for (const table of ['cost_events', 'cost_daily_agg_v2', 'cost_customer_daily_agg']) {
      await client.command({
        query: `ALTER TABLE ${table} DELETE WHERE builder_id = {builder:String}`,
        query_params: { builder: BUILDER_ID },
        clickhouse_settings: { mutations_sync: '1' },
      });
    }
    await client.close();
  });

  async function showCreate(table: string): Promise<string> {
    const result = await client!.query({
      query: `SHOW CREATE TABLE ${table}`,
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<Record<string, unknown>>;
    return Object.values(rows[0] ?? {})
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
  }

  async function materializedViewUuid(table: string): Promise<string> {
    const result = await client!.query({
      query: `
        SELECT uuid
          FROM system.tables
         WHERE database = currentDatabase()
           AND name = {table:String}
      `,
      query_params: { table },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ uuid?: string }>;
    expect(rows).toHaveLength(1);
    return String(rows[0]?.uuid ?? '');
  }

  async function applyClickHouseFile(relativePath: string): Promise<void> {
    const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const statement of splitClickHouseStatements(content)) {
      await client!.command({
        query: statement.endsWith(';') ? statement : `${statement};`,
      });
    }
  }

  it('uses retention_days in the cost_events TTL expression', async () => {
    const createTable = await showCreate('cost_events');

    expect(createTable).toContain('toIntervalDay(retention_days)');
  });

  it('uses billing_retention_days in aggregate target TTL expressions', async () => {
    const dailyCreate = await showCreate('cost_daily_agg_v2');
    const customerDailyCreate = await showCreate('cost_customer_daily_agg');

    expect(dailyCreate).toContain('toIntervalDay(billing_retention_days)');
    expect(customerDailyCreate).toContain('toIntervalDay(billing_retention_days)');
  });

  it('replays 009 without recreating the customer daily materialized view', async () => {
    const beforeUuid = await materializedViewUuid('cost_customer_daily_agg_mv');

    await applyClickHouseFile('db/clickhouse/009_cost_customer_daily_agg_retention.sql');

    const afterUuid = await materializedViewUuid('cost_customer_daily_agg_mv');
    const customerDailyCreate = await showCreate('cost_customer_daily_agg');

    expect(afterUuid).toBe(beforeUuid);
    expect(customerDailyCreate).toContain('toIntervalDay(billing_retention_days)');
  });

  it('round-trips explicit retention fields on insert', async () => {
    const spanId = crypto.randomUUID();
    await client!.insert({
      table: 'cost_events',
      values: [
        eventRow({
          span_id: spanId,
          retention_days: 90,
          billing_retention_days: 365,
        }),
      ],
      format: 'JSONEachRow',
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });

    const result = await client!.query({
      query: `
        SELECT retention_days, billing_retention_days
          FROM cost_events
         WHERE builder_id = {builder:String}
           AND span_id = {span:UUID}
      `,
      query_params: { builder: BUILDER_ID, span: spanId },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{
      retention_days: number | string;
      billing_retention_days: number | string;
    }>;

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.retention_days)).toBe(90);
    expect(Number(rows[0]?.billing_retention_days)).toBe(365);
  });

  it('defaults legacy inserts that omit retention fields to 365/365', async () => {
    const spanId = crypto.randomUUID();
    await client!.insert({
      table: 'cost_events',
      values: [eventRow({ span_id: spanId })],
      format: 'JSONEachRow',
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });

    const result = await client!.query({
      query: `
        SELECT retention_days, billing_retention_days
          FROM cost_events
         WHERE builder_id = {builder:String}
           AND span_id = {span:UUID}
      `,
      query_params: { builder: BUILDER_ID, span: spanId },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{
      retention_days: number | string;
      billing_retention_days: number | string;
    }>;

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.retention_days)).toBe(365);
    expect(Number(rows[0]?.billing_retention_days)).toBe(365);
  });

  it('projects billing_retention_days into cost_daily_agg_v2 dimension rows', async () => {
    const customerId = `${BUILDER_ID}:cust_daily_v2`;
    await client!.insert({
      table: 'cost_events',
      values: [
        eventRow({
          customer_id: customerId,
          span_id: crypto.randomUUID(),
          provider: 'openai',
          model: 'gpt-4o-mini',
          step_name: 'chat',
          tokens_in: 10,
          tokens_out: 2,
          cost_usd: 0.1,
          latency_ms: 100,
          billing_retention_days: 90,
        }),
        eventRow({
          customer_id: customerId,
          span_id: crypto.randomUUID(),
          provider: 'openai',
          model: 'gpt-4o-mini',
          step_name: 'chat',
          tokens_in: 20,
          tokens_out: 3,
          cost_usd: 0.2,
          latency_ms: 200,
          billing_retention_days: 365,
        }),
      ],
      format: 'JSONEachRow',
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });

    const result = await client!.query({
      query: `
        SELECT
          billing_retention_days,
          sum(total_tokens_in) AS total_tokens_in,
          sum(total_tokens_out) AS total_tokens_out,
          sum(total_cost_usd) AS total_cost_usd,
          sum(event_count) AS event_count
        FROM cost_daily_agg_v2
        WHERE builder_id = {builder:String}
          AND customer_id = {customer:String}
        GROUP BY billing_retention_days
        ORDER BY billing_retention_days
      `,
      query_params: { builder: BUILDER_ID, customer: customerId },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{
      billing_retention_days: number | string;
      total_tokens_in: number | string;
      total_tokens_out: number | string;
      total_cost_usd: number | string;
      event_count: number | string;
    }>;

    expect(rows.map((row) => Number(row.billing_retention_days))).toEqual([90, 365]);
    expect(rows.map((row) => Number(row.total_tokens_in))).toEqual([10, 20]);
    expect(rows.map((row) => Number(row.total_tokens_out))).toEqual([2, 3]);
    expect(rows.map((row) => Number(row.event_count))).toEqual([1, 1]);
    expect(rows.map((row) => Number(row.total_cost_usd))).toEqual([0.1, 0.2]);
  });

  it('max-merges billing_retention_days in cost_customer_daily_agg', async () => {
    const customerId = `${BUILDER_ID}:cust_customer_daily`;
    await client!.insert({
      table: 'cost_events',
      values: [
        eventRow({
          customer_id: customerId,
          span_id: crypto.randomUUID(),
          cost_usd: 1,
          billing_retention_days: 90,
        }),
        eventRow({
          customer_id: customerId,
          span_id: crypto.randomUUID(),
          cost_usd: 2,
          billing_retention_days: 365,
        }),
      ],
      format: 'JSONEachRow',
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });

    const result = await client!.query({
      query: `
        SELECT
          sum(total_cost_usd) AS total_cost_usd,
          sum(event_count) AS event_count,
          max(billing_retention_days) AS billing_retention_days
        FROM cost_customer_daily_agg
        WHERE builder_id = {builder:String}
          AND customer_id = {customer:String}
        GROUP BY day, builder_id, customer_id, is_demo
      `,
      query_params: { builder: BUILDER_ID, customer: customerId },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{
      total_cost_usd: number | string;
      event_count: number | string;
      billing_retention_days: number | string;
    }>;

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_cost_usd)).toBe(3);
    expect(Number(rows[0]?.event_count)).toBe(2);
    expect(Number(rows[0]?.billing_retention_days)).toBe(365);
  });
});
