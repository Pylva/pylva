import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';

const baseUrl = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
const database = `pylva_utc_timestamp_${crypto.randomBytes(6).toString('hex')}`;
let admin: ClickHouseClient;
let isolated: ClickHouseClient;

function databaseUrl(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function applyDdl(client: ClickHouseClient, ddl: string): Promise<void> {
  for (const query of splitClickHouseStatements(ddl)) await client.command({ query });
}

async function insertLegacyEvent(spanId: string, timestamp: string): Promise<void> {
  const builderId = '00000000-0000-4000-8000-000000000001';
  await isolated.insert({
    table: 'cost_events',
    values: [
      {
        timestamp,
        builder_id: builderId,
        trace_id: crypto.randomUUID(),
        span_id: spanId,
        parent_span_id: null,
        customer_id: `${builderId}:utc_customer`,
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'chat.completions',
        step_name: 'utc_regression',
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: '0.000200',
        pricing_status: 'priced',
        latency_ms: 12,
        status: 'success',
        cost_source: 'auto',
        instrumentation_tier: 'sdk_wrapper',
        metric: null,
        metric_value: null,
        stream_aborted: 0,
        abort_savings: '0',
        savings_usd: 0,
        is_demo: 0,
        retention_days: 365,
        billing_retention_days: 365,
        metadata: '{}',
      },
    ],
    format: 'JSONEachRow',
  });
}

beforeAll(async () => {
  admin = createClient({ url: baseUrl, request_timeout: 30_000 });
  await admin.command({ query: `CREATE DATABASE ${database}` });
  isolated = createClient({
    url: databaseUrl(database),
    request_timeout: 30_000,
    clickhouse_settings: { session_timezone: 'Asia/Riyadh' },
  });
});

afterAll(async () => {
  await isolated?.close().catch(() => undefined);
  await admin?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
  await admin?.close().catch(() => undefined);
});

describe('legacy cost event UTC timestamp migration', () => {
  it('preserves old epochs and makes new inserts independent of an Asia/Riyadh session', async () => {
    const directory = path.resolve('db/clickhouse');
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql')).sort();

    // Emulate an existing installation at 011. The checked-in 001 is already
    // corrected for fresh databases, so restore its prior bare DateTime only in
    // this isolated migration fixture.
    for (const file of files.filter((name) => name < '012_')) {
      let ddl = await fs.readFile(path.join(directory, file), 'utf8');
      if (file === '001_cost_events.sql') {
        ddl = ddl.replace(
          "timestamp             DateTime('UTC'),",
          'timestamp             DateTime,',
        );
      }
      await applyDdl(isolated, ddl);
    }

    const session = await isolated.query({
      query: 'SELECT timezone() AS timezone',
      format: 'JSONEachRow',
    });
    await expect(session.json()).resolves.toEqual([{ timezone: 'Asia/Riyadh' }]);

    const oldSpanId = crypto.randomUUID();
    await insertLegacyEvent(oldSpanId, '2026-07-14 14:55:00');
    const before = await isolated.query({
      query: `SELECT toUnixTimestamp(timestamp) AS epoch
              FROM cost_events WHERE span_id = {span:UUID}`,
      query_params: { span: oldSpanId },
      format: 'JSONEachRow',
    });
    const beforeRows = (await before.json()) as Array<{ epoch: number | string }>;
    expect(Number(beforeRows[0]?.epoch)).toBe(Date.parse('2026-07-14T11:55:00.000Z') / 1000);

    await applyDdl(
      isolated,
      await fs.readFile(path.join(directory, '012_cost_events_utc_timestamp.sql'), 'utf8'),
    );

    const after = await isolated.query({
      query: `SELECT toUnixTimestamp(timestamp) AS epoch,
                     toTypeName(timestamp) AS timestamp_type
              FROM cost_events WHERE span_id = {span:UUID}`,
      query_params: { span: oldSpanId },
      format: 'JSONEachRow',
    });
    await expect(after.json()).resolves.toEqual([
      {
        epoch: beforeRows[0]!.epoch,
        timestamp_type: "DateTime('UTC')",
      },
    ]);

    const newSpanId = crypto.randomUUID();
    await insertLegacyEvent(newSpanId, '2026-07-14 14:55:00');
    const canonical = await isolated.query({
      query: `SELECT span_id, toUnixTimestamp(timestamp) AS epoch,
                     toTypeName(timestamp) AS timestamp_type
              FROM cost_events_with_control
              WHERE builder_id = {builder:String}
                AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
                AND timestamp < parseDateTime64BestEffort({to:String}, 3, 'UTC')`,
      query_params: {
        builder: '00000000-0000-4000-8000-000000000001',
        from: '2026-07-14 14:54:00',
        to: '2026-07-14 14:56:00',
      },
      format: 'JSONEachRow',
    });
    await expect(canonical.json()).resolves.toEqual([
      {
        span_id: newSpanId,
        epoch: Date.parse('2026-07-14T14:55:00.000Z') / 1000,
        timestamp_type: "DateTime64(3, 'UTC')",
      },
    ]);
  });
});
