import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';
import {
  createBudgetProjectionTarget,
  type BudgetProjectionClickHouseClient,
  type BudgetProjectionTarget,
} from '../../src/lib/budget-projection/clickhouse.js';
import { toolPayload } from '../budget-projection/fixtures.js';

const baseUrl = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
const previousUrl = process.env['CLICKHOUSE_URL'];
const database = `pylva_dashboard_mixed_${crypto.randomBytes(6).toString('hex')}`;
const range = {
  from: new Date('2026-07-14T00:00:00.000Z'),
  to: new Date('2026-07-14T23:59:59.000Z'),
};

let admin: ClickHouseClient;
let isolated: ClickHouseClient;
let target: BudgetProjectionTarget;
let dashboard: typeof import('../../src/lib/clickhouse/dashboard-queries.js');
let closeDashboardClickHouse: () => Promise<void>;

function databaseUrl(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function applyClickHouseMigrations(client: ClickHouseClient): Promise<void> {
  const directory = path.resolve('db/clickhouse');
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const ddl = await fs.readFile(path.join(directory, file), 'utf8');
    for (const query of splitClickHouseStatements(ddl)) await client.command({ query });
  }
}

async function insertLegacy(
  builderId: string,
  externalCustomerId: string,
  costUsd: string,
): Promise<void> {
  await isolated.insert({
    table: 'cost_events',
    values: [
      {
        timestamp: '2026-07-14 09:00:00',
        builder_id: builderId,
        trace_id: crypto.randomUUID(),
        span_id: crypto.randomUUID(),
        parent_span_id: null,
        customer_id: `${builderId}:${externalCustomerId}`,
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'chat.completions',
        step_name: 'legacy_step',
        tokens_in: 100,
        tokens_out: 25,
        cost_usd: costUsd,
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
        billing_retention_days: 2_555,
        metadata: '{}',
      },
    ],
    format: 'JSONEachRow',
  });
}

async function insertControlled(
  builderId: string,
  externalCustomerId: string,
  costUsd: string,
  hash: string,
  retries = 1,
): Promise<void> {
  const payload = toolPayload({
    builder_id: builderId,
    event_id: crypto.randomUUID(),
    reservation_decision_id: crypto.randomUUID(),
    operation_id: crypto.randomUUID(),
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    customer_id: `${builderId}:${externalCustomerId}`,
    cost_usd: costUsd,
  });
  for (let attempt = 0; attempt < retries; attempt += 1) await target.insert(payload, hash);
}

beforeAll(async () => {
  admin = createClient({ url: baseUrl, request_timeout: 30_000 });
  await admin.command({ query: `CREATE DATABASE ${database}` });
  const url = databaseUrl(database);
  isolated = createClient({ url, request_timeout: 30_000 });
  await applyClickHouseMigrations(isolated);
  target = createBudgetProjectionTarget(
    isolated as unknown as BudgetProjectionClickHouseClient,
    10_000,
  );

  process.env['CLICKHOUSE_URL'] = url;
  dashboard = await import('../../src/lib/clickhouse/dashboard-queries.js');
  ({ closeClickhouse: closeDashboardClickHouse } =
    await import('../../src/lib/clickhouse/client.js'));
});

afterAll(async () => {
  await closeDashboardClickHouse?.().catch(() => undefined);
  await isolated?.close().catch(() => undefined);
  await admin?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
  await admin?.close().catch(() => undefined);
  if (previousUrl === undefined) delete process.env['CLICKHOUSE_URL'];
  else process.env['CLICKHOUSE_URL'] = previousUrl;
});

describe('dashboard analytics on canonical mixed ClickHouse traffic', () => {
  it('includes legacy-only and controlled-only builders', async () => {
    const legacyBuilder = crypto.randomUUID();
    const controlledBuilder = crypto.randomUUID();
    await insertLegacy(legacyBuilder, 'legacy_only', '0.001000');
    await insertControlled(controlledBuilder, 'controlled_only', '0.004', 'a'.repeat(64));

    await expect(
      dashboard.getOverview(legacyBuilder, range, {
        includeDemo: false,
        hasRealEvents: true,
      }),
    ).resolves.toMatchObject({ total_spend_usd: 0.001, event_count: 1, customer_count: 1 });
    await expect(
      dashboard.getOverview(controlledBuilder, range, {
        includeDemo: false,
        hasRealEvents: true,
      }),
    ).resolves.toMatchObject({ total_spend_usd: 0.004, event_count: 1, customer_count: 1 });
    await expect(dashboard.hasAnyRealEvents(controlledBuilder)).resolves.toBe(true);
  });

  it('merges mixed traffic and counts an identical controlled retry once everywhere', async () => {
    const builderId = crypto.randomUUID();
    const customerId = 'mixed_customer';
    await insertLegacy(builderId, customerId, '0.002500');
    await insertControlled(builderId, customerId, '0.00375', 'b'.repeat(64), 2);

    const overview = await dashboard.getOverview(builderId, range, {
      includeDemo: false,
      hasRealEvents: true,
    });
    expect(overview.event_count).toBe(2);
    expect(overview.customer_count).toBe(1);
    expect(overview.total_spend_usd).toBeCloseTo(0.00625, 12);

    const [topUser] = await dashboard.getTopEndUsers(builderId, range, 5, {
      includeDemo: false,
    });
    expect(topUser).toMatchObject({ customer_id: customerId, event_count: 2 });
    expect(topUser?.total_spend_usd).toBeCloseTo(0.00625, 12);

    const [summary] = await dashboard.getCustomerCostSummary(builderId, range, {
      includeDemo: false,
    });
    expect(summary).toMatchObject({ customer_id: customerId, event_count: 2 });
    expect(summary?.total_spend_usd).toBeCloseTo(0.00625, 12);

    const detail = await dashboard.getCustomerDetail(
      builderId,
      `${builderId}:${customerId}`,
      range,
      { includeDemo: false },
    );
    expect(detail.event_count).toBe(2);
    expect(detail.total_spend_usd).toBeCloseTo(0.00625, 12);
    expect(detail.by_step.reduce((sum, row) => sum + row.call_count, 0)).toBe(2);

    const models = await dashboard.getModelBreakdown(builderId, range, { includeDemo: false });
    expect(models.reduce((sum, row) => sum + row.call_count, 0)).toBe(2);
    expect(models.reduce((sum, row) => sum + row.total_spend_usd, 0)).toBeCloseTo(0.00625, 12);

    const traces = await dashboard.getRecentTraces(builderId, range, { includeDemo: false });
    expect(traces).toHaveLength(2);
    expect(traces.reduce((sum, row) => sum + row.span_count, 0)).toBe(2);

    const physical = await isolated.query({
      query: `SELECT count() AS count FROM budget_cost_events
              WHERE builder_id = {builder:String}`,
      query_params: { builder: builderId },
      format: 'JSONEachRow',
    });
    const physicalRows = (await physical.json()) as Array<{ count: string }>;
    expect(Number(physicalRows[0]?.count)).toBe(2);
  });
});
