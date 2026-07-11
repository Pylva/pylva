import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';
import {
  CostSource,
  EventStatus,
  Framework,
  InstrumentationTier,
  type IngestResponse,
  type TelemetryEvent,
} from '@pylva/shared';
import { clickhouse } from '../../src/lib/clickhouse/client.js';
import { chTimestamp } from '../../src/lib/clickhouse/datetime.js';
import { handleTelemetryIngest } from '../../src/lib/ingest/public-handler.js';
import { runBackfill } from '../../src/lib/pricing/backfill.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

// Recent timestamp: free-tier telemetry retention is now 30 days stamped at
// ingest — a fixed historical date would be expired by ClickHouse TTL on
// insert and the rows would never be readable back.
const EVENT_TIMESTAMP = new Date(Date.now() - 60_000).toISOString();

let sql: ReturnType<typeof postgres>;
const builderIds: string[] = [];

function uniqueMetric(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

async function createBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`${label}-${suffix}@example.com`}, ${label}, 'free', ${`${label}-${suffix}`})
    RETURNING id
  `;
  const builderId = row!.id;
  builderIds.push(builderId);
  return builderId;
}

async function insertMetricPrice(
  builderId: string,
  metric: string,
  pricePerUnitUsd: number,
): Promise<void> {
  await sql`
    INSERT INTO custom_pricing (
      builder_id, provider, model, metric,
      price_per_unit_usd, effective_from, source
    ) VALUES (
      ${builderId}, NULL, NULL, ${metric},
      ${pricePerUnitUsd}, '2026-01-01T00:00:00Z'::timestamptz, 'builder_manual'
    )
  `;
}

function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    schema_version: '1.6',
    run_id: crypto.randomUUID(),
    parent_run_id: null,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    customer_id: `cust_${crypto.randomBytes(3).toString('hex')}`,
    step_name: 'integration',
    model: null,
    provider: null,
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 12,
    tool_name: null,
    status: EventStatus.SUCCESS,
    framework: Framework.NONE,
    instrumentation_tier: InstrumentationTier.REPORTED,
    cost_source: CostSource.CONFIGURED,
    metric: 'metric_missing_override',
    metric_value: 1,
    stream_aborted: false,
    abort_savings_usd: 0,
    sdk_version: 'test',
    timestamp: EVENT_TIMESTAMP,
    ...overrides,
  };
}

async function ingest(
  builderId: string,
  events: TelemetryEvent[],
): Promise<{ status: number; body: IngestResponse }> {
  const response = await handleTelemetryIngest({
    builderId,
    keyId: 'integration-key',
    rawBody: JSON.stringify({
      batch_id: crypto.randomUUID(),
      sdk_version: 'test',
      events,
    }),
  });
  return {
    status: response.status,
    body: JSON.parse(response.body) as IngestResponse,
  };
}

async function clickhouseRows<T extends Record<string, unknown>>(
  builderId: string,
  spanIds: string[],
): Promise<T[]> {
  const result = await clickhouse.query({
    query: `
      SELECT span_id, cost_usd, pricing_status, metric, metric_value
      FROM cost_events
      WHERE builder_id = {builder:String}
        AND span_id IN {spanIds:Array(UUID)}
      ORDER BY span_id
    `,
    query_params: {
      builder: builderId,
      spanIds,
    },
    format: 'JSONEachRow',
  });
  return (await result.json()) as T[];
}

async function insertPendingCostEvent(params: {
  builderId: string;
  metric: string;
  metricValue: number;
  spanId?: string;
}): Promise<string> {
  const spanId = params.spanId ?? crypto.randomUUID();
  await clickhouse.insert({
    table: 'cost_events',
    values: [
      {
        timestamp: chTimestamp(new Date(EVENT_TIMESTAMP)),
        builder_id: params.builderId,
        trace_id: crypto.randomUUID(),
        span_id: spanId,
        parent_span_id: null,
        customer_id: `${params.builderId}:cust_${crypto.randomBytes(3).toString('hex')}`,
        provider: 'other',
        model: null,
        operation: 'reported',
        step_name: 'integration',
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: null,
        pricing_status: 'needs_input',
        latency_ms: 12,
        status: 'success',
        cost_source: 'configured',
        instrumentation_tier: 'reported',
        metric: params.metric,
        metric_value: params.metricValue,
        stream_aborted: 0,
        abort_savings: 0,
        metadata: '{}',
      },
    ],
    format: 'JSONEachRow',
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 1,
    },
  });
  return spanId;
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
});

afterAll(async () => {
  for (const builderId of builderIds) {
    await clickhouse.command({
      query: 'ALTER TABLE cost_events DELETE WHERE builder_id = {builder:String}',
      query_params: { builder: builderId },
      clickhouse_settings: {
        mutations_sync: '1',
      },
    });
  }
  if (builderIds.length > 0) {
    await sql`DELETE FROM builders WHERE id IN ${sql(builderIds)}`;
  }
  await sql.end();
});

describe('Decimal(10,6) overflow root-cause protection', () => {
  it('persists a mixed ingest batch when one computed cost is over the storable max', async () => {
    const builderId = await createBuilder('decimal-ingest');
    const metric = uniqueMetric('reported_overflow');
    await insertMetricPrice(builderId, metric, 0.2);

    const normal = event({ metric, metric_value: 10 });
    const overflow = event({ metric, metric_value: 1_000_000 });
    const response = await ingest(builderId, [normal, overflow]);

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(2);
    expect(response.body.rejected).toBe(0);
    expect(response.body.warnings).toHaveLength(1);
    expect(response.body.warnings?.[0]?.event_index).toBe(1);

    const rows = await clickhouseRows<{
      span_id: string;
      cost_usd: string | null;
      pricing_status: string;
    }>(builderId, [normal.span_id, overflow.span_id]);
    expect(rows).toHaveLength(2);
    const bySpan = new Map(rows.map((row) => [row.span_id, row]));
    expect(Number(bySpan.get(normal.span_id)?.cost_usd)).toBeCloseTo(2, 6);
    expect(bySpan.get(normal.span_id)?.pricing_status).toBe('priced');
    expect(bySpan.get(overflow.span_id)?.cost_usd).toBeNull();
    expect(bySpan.get(overflow.span_id)?.pricing_status).toBe('needs_input');
  });

  it('rejects one over-limit abort_savings_usd event without rolling back valid events', async () => {
    const builderId = await createBuilder('decimal-abort');
    const metric = uniqueMetric('abort_savings');
    await insertMetricPrice(builderId, metric, 0.01);

    const normal = event({ metric, metric_value: 1 });
    const badSavings = event({
      metric,
      metric_value: 1,
      status: EventStatus.ABORTED,
      stream_aborted: true,
      abort_savings_usd: 10_000,
    });
    const response = await ingest(builderId, [normal, badSavings]);

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(1);
    expect(response.body.rejected).toBe(1);
    expect(response.body.errors?.[0]?.index).toBe(1);

    const rows = await clickhouseRows(builderId, [normal.span_id, badSavings.span_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.span_id).toBe(normal.span_id);
  });

  it('backfills only storable rows and keeps onboarding open for overflow rows', async () => {
    const builderId = await createBuilder('decimal-backfill');
    const mixedMetric = uniqueMetric('backfill_mixed');
    const resolvedMetric = uniqueMetric('backfill_resolved');
    await insertMetricPrice(builderId, mixedMetric, 0.2);
    await insertMetricPrice(builderId, resolvedMetric, 0.2);
    await sql`
      INSERT INTO pricing_onboarding_tasks (builder_id, metric, status)
      VALUES
        (${builderId}, ${mixedMetric}, 'open'),
        (${builderId}, ${resolvedMetric}, 'open')
    `;

    const safeSpan = await insertPendingCostEvent({
      builderId,
      metric: mixedMetric,
      metricValue: 10,
    });
    const overflowSpan = await insertPendingCostEvent({
      builderId,
      metric: mixedMetric,
      metricValue: 1_000_000,
    });
    const resolveSpan = await insertPendingCostEvent({
      builderId,
      metric: resolvedMetric,
      metricValue: 10,
    });

    await expect(runBackfill()).resolves.toMatchObject({ updated: expect.any(Number) });

    const rows = await clickhouseRows<{
      span_id: string;
      cost_usd: string | null;
      pricing_status: string;
    }>(builderId, [safeSpan, overflowSpan, resolveSpan]);
    const bySpan = new Map(rows.map((row) => [row.span_id, row]));
    expect(Number(bySpan.get(safeSpan)?.cost_usd)).toBeCloseTo(2, 6);
    expect(bySpan.get(safeSpan)?.pricing_status).toBe('priced');
    expect(bySpan.get(overflowSpan)?.cost_usd).toBeNull();
    expect(bySpan.get(overflowSpan)?.pricing_status).toBe('needs_input');
    expect(Number(bySpan.get(resolveSpan)?.cost_usd)).toBeCloseTo(2, 6);
    expect(bySpan.get(resolveSpan)?.pricing_status).toBe('priced');

    const tasks = await sql<{ metric: string; status: string }[]>`
      SELECT metric, status
      FROM pricing_onboarding_tasks
      WHERE builder_id = ${builderId}
        AND metric IN (${mixedMetric}, ${resolvedMetric})
      ORDER BY metric
    `;
    const byMetric = new Map(tasks.map((task) => [task.metric, task.status]));
    expect(byMetric.get(mixedMetric)).toBe('open');
    expect(byMetric.get(resolvedMetric)).toBe('resolved');
  });
});
