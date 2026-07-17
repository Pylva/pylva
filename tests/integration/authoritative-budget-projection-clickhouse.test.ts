import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';
import {
  BudgetUsageAggregateError,
  getUsageForPeriod,
} from '../../src/lib/billing/clickhouse-usage.js';
import {
  createBudgetProjectionTarget,
  type BudgetProjectionClickHouseClient,
  type BudgetProjectionTarget,
} from '../../src/lib/budget-projection/clickhouse.js';
import { checkClickHouseReadiness } from '../../src/lib/clickhouse/readiness.js';
import type { BudgetProjectionPostgresStore } from '../../src/lib/budget-projection/postgres.js';
import { __budgetProjectionWorkerTesting } from '../../src/lib/budget-projection/worker.js';
import { projectionLease, toolPayload } from '../budget-projection/fixtures.js';

const baseUrl = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
const database = `pylva_budget_projection_${crypto.randomBytes(6).toString('hex')}`;
let admin: ClickHouseClient;
let isolated: ClickHouseClient;
let target: BudgetProjectionTarget;

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
    for (const query of splitClickHouseStatements(ddl)) {
      await client.command({ query });
    }
  }
}

async function rows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const response = await isolated.query({
    query,
    query_params: params,
    format: 'JSONEachRow',
  });
  return (await response.json()) as T[];
}

beforeAll(async () => {
  admin = createClient({ url: baseUrl, request_timeout: 30_000 });
  await admin.command({ query: `CREATE DATABASE ${database}` });
  isolated = createClient({ url: databaseUrl(database), request_timeout: 30_000 });
  await applyClickHouseMigrations(isolated);
  target = createBudgetProjectionTarget(
    isolated as unknown as BudgetProjectionClickHouseClient,
    10_000,
  );
});

afterAll(async () => {
  await isolated?.close().catch(() => undefined);
  await admin?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
  await admin?.close().catch(() => undefined);
});

describe('authoritative budget projection on real ClickHouse', () => {
  it('passes the exact authoritative schema fingerprint on a fresh database', async () => {
    const readiness = await checkClickHouseReadiness(isolated);
    expect(readiness.ready, JSON.stringify(readiness)).toBe(true);
    expect(readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'clickhouse.authoritative_budget_schema',
          ok: true,
        }),
      ]),
    );
  });

  it('collapses identical retry rows at the FINAL and compatible read boundaries', async () => {
    const builderId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const hash = 'a'.repeat(64);
    const payload = toolPayload({
      builder_id: builderId,
      event_id: eventId,
      reservation_decision_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      customer_id: `${builderId}:retry_customer`,
      cost_usd: '99999999999999999999999999.123456789012345678',
      metric_value: '99999999999999999999.123456789012345678',
    });
    await target.insert(payload, hash);
    await target.insert(payload, hash);

    await expect(target.inspect(builderId, eventId, hash)).resolves.toEqual({
      state: 'matched',
      physical_rows: 2,
      logical_rows: 1,
      hashes: [hash],
    });
    const physical = await rows<{ count: number | string }>(
      `SELECT count() AS count FROM budget_cost_events
       WHERE builder_id = {builder:String} AND event_id = {event:UUID}`,
      { builder: builderId, event: eventId },
    );
    const finalRows = await rows<{
      cost_usd: string;
      event_id: string;
      metric_value: string;
    }>(
      `SELECT event_id, toString(cost_usd) AS cost_usd,
              toString(metric_value) AS metric_value
       FROM budget_cost_events_final
       WHERE payload_hash_count = 1
         AND builder_id = {builder:String} AND event_id = {event:UUID}`,
      { builder: builderId, event: eventId },
    );
    const compatible = await rows<{ count: number | string; event_origin: string }>(
      `SELECT event_origin, count() AS count
       FROM cost_events_with_control
       WHERE builder_id = {builder:String} AND event_id = {event:UUID}
       GROUP BY event_origin`,
      { builder: builderId, event: eventId },
    );
    expect(Number(physical[0]?.count)).toBe(2);
    expect(finalRows).toEqual([
      {
        event_id: eventId,
        cost_usd: payload.cost_usd,
        metric_value: payload.metric_value,
      },
    ]);
    expect(compatible).toHaveLength(1);
    expect(compatible[0]?.event_origin).toBe('authoritative_budget');
    expect(Number(compatible[0]?.count)).toBe(1);
  });

  it('detects a conflicting hash for the same immutable event identity', async () => {
    const builderId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const payload = toolPayload({
      builder_id: builderId,
      event_id: eventId,
      reservation_decision_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      customer_id: `${builderId}:conflict_customer`,
    });
    await target.insert(payload, 'a'.repeat(64));
    await target.insert(payload, 'b'.repeat(64));
    // Force the same compaction that a production ReplacingMergeTree performs
    // in the background. Distinct hashes must remain durable evidence rather
    // than allowing the replacement merge to hide the conflict.
    await isolated.command({ query: 'OPTIMIZE TABLE budget_cost_events FINAL' });
    await expect(target.inspect(builderId, eventId, 'a'.repeat(64))).resolves.toMatchObject({
      state: 'conflict',
      physical_rows: 2,
      hashes: ['a'.repeat(64), 'b'.repeat(64)],
    });
    const visible = await rows<{ count: number | string }>(
      `SELECT count() AS count FROM cost_events_with_control
       WHERE builder_id = {builder:String} AND event_id = {event:UUID}`,
      { builder: builderId, event: eventId },
    );
    expect(Number(visible[0]?.count)).toBe(0);
  });

  it('detects a cross-timestamp identity conflict during reconciliation and never verifies it', async () => {
    const builderId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const first = toolPayload({
      builder_id: builderId,
      event_id: eventId,
      reservation_decision_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      customer_id: `${builderId}:cross_timestamp_conflict`,
      timestamp: '2026-07-12T09:10:11.123Z',
    });
    const second = {
      ...first,
      timestamp: '2026-07-13T09:10:11.123Z',
    };
    await target.insert(first, 'd'.repeat(64));
    await target.insert(second, 'e'.repeat(64));

    // Inspection is deliberately keyed only by builder/event, never by time.
    // This is the billing/reconciliation safety net even if an unsupported
    // out-of-band writer violates the immutable outbox timestamp invariant.
    await expect(target.inspect(builderId, eventId, 'd'.repeat(64))).resolves.toMatchObject({
      state: 'conflict',
      physical_rows: 2,
      logical_rows: 2,
      hashes: ['d'.repeat(64), 'e'.repeat(64)],
    });

    const store = {
      markVerified: vi.fn(async () => true),
    } as unknown as BudgetProjectionPostgresStore;
    await expect(
      __budgetProjectionWorkerTesting.reconcileItem(store, target, {
        builder_id: builderId,
        outbox_id: crypto.randomUUID(),
        event_id: eventId,
        payload_hash: 'd'.repeat(64),
      }),
    ).resolves.toBe('conflict');
    expect(store.markVerified).not.toHaveBeenCalled();
  });

  it('keeps legacy non-finite metric rows readable through the compatible view', async () => {
    const builderId = crypto.randomUUID();
    await isolated.command({
      query: `
        INSERT INTO cost_events (
          timestamp, builder_id, trace_id, span_id, parent_span_id,
          customer_id, provider, model, operation, step_name,
          tokens_in, tokens_out, cost_usd, latency_ms, status,
          cost_source, instrumentation_tier, metric, metric_value,
          stream_aborted, abort_savings, metadata
        ) VALUES (
          now(), {builder:String}, generateUUIDv4(), generateUUIDv4(), NULL,
          concat({builder:String}, ':legacy_nan'), 'tool', NULL, 'tool.call', NULL,
          0, 0, toDecimal64(0, 6), 1, 'ok',
          'configured', 'reported', 'legacy_metric', CAST('NaN', 'Float64'),
          0, toDecimal64(0, 6), '{}'
        )
      `,
      query_params: { builder: builderId },
    });

    const visible = await rows<{ event_origin: string; metric_is_nan: number | string }>(
      `SELECT event_origin, isNaN(metric_value) AS metric_is_nan
       FROM cost_events_with_control
       WHERE builder_id = {builder:String} AND metric = 'legacy_metric'`,
      { builder: builderId },
    );
    expect(visible).toEqual([{ event_origin: 'legacy', metric_is_nan: 1 }]);

    const query = async (
      queryBuilderId: string,
      statement: string,
      params: Record<string, unknown> = {},
    ) => rows(statement, { ...params, builder_id: queryBuilderId });
    await expect(
      getUsageForPeriod(
        {
          builderId,
          customerId: `${builderId}:legacy_nan`,
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: new Date('2027-01-01T00:00:00.000Z'),
        },
        { query },
      ),
    ).rejects.toBeInstanceOf(BudgetUsageAggregateError);
  });

  it('purges telemetry details while retaining exact controlled billing facts', async () => {
    const builderId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    timestamp.setUTCMilliseconds(123);
    const payload = toolPayload({
      builder_id: builderId,
      event_id: eventId,
      reservation_decision_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      customer_id: `${builderId}:retention_customer`,
      timestamp: timestamp.toISOString(),
      retention_days: 1,
      billing_retention_days: 90,
      metric_value: '7.123456789012345678',
      cost_usd: '0.123456789012345678',
    });
    await target.insert(payload, 'f'.repeat(64));
    await isolated.command({ query: 'ALTER TABLE budget_cost_events MATERIALIZE TTL' });
    await isolated.command({ query: 'OPTIMIZE TABLE budget_cost_events FINAL' });

    const physical = await rows<{
      metadata: string;
      metric_value: string;
      trace_id: string;
    }>(
      `SELECT metadata, toString(metric_value) AS metric_value, toString(trace_id) AS trace_id
       FROM budget_cost_events FINAL
       WHERE builder_id = {builder:String} AND event_id = {event:UUID}`,
      { builder: builderId, event: eventId },
    );
    expect(physical).toEqual([
      {
        metadata: '',
        metric_value: payload.metric_value,
        trace_id: '00000000-0000-0000-0000-000000000000',
      },
    ]);

    const dashboardRows = await rows<{ count: number | string }>(
      `SELECT count() AS count
       FROM cost_events_with_control
       WHERE builder_id = {builder:String} AND event_id = {event:UUID}`,
      { builder: builderId, event: eventId },
    );
    expect(Number(dashboardRows[0]?.count)).toBe(0);

    const query = async (
      queryBuilderId: string,
      statement: string,
      params: Record<string, unknown> = {},
    ) => rows(statement, { ...params, builder_id: queryBuilderId });
    const usage = await getUsageForPeriod(
      {
        builderId,
        customerId: payload.customer_id,
        from: new Date(timestamp.getTime() - 1_000),
        to: new Date(timestamp.getTime() + 1_000),
        useAuthoritativeBillingFacts: true,
      },
      { query },
    );
    expect(usage.by_metric).toEqual({ credit: 7.123456789012345678 });
  });

  it('pushes builder and time predicates below canonical grouping at high cardinality', async () => {
    const prefix = `perf_${crypto.randomBytes(4).toString('hex')}_`;
    await isolated.command({
      query: `
        INSERT INTO budget_cost_events (
          event_id, payload_hash, timestamp, builder_id, reservation_decision_id,
          operation_id, trace_id, span_id, parent_span_id, customer_id, provider,
          model, operation, step_name, tokens_in, tokens_out, cost_usd,
          pricing_status, latency_ms, status, cost_source, instrumentation_tier,
          metric, metric_value, stream_aborted, abort_savings, savings_usd,
          is_demo, retention_days, billing_retention_days, metadata
        )
        SELECT
          generateUUIDv4(), repeat('a', 64),
          toDateTime64('2026-01-01 00:00:00', 3, 'UTC') + toIntervalHour(number % 2048),
          concat({prefix:String}, toString(intDiv(number, 2048))),
          generateUUIDv4(), generateUUIDv4(), generateUUIDv4(), generateUUIDv4(), NULL,
          concat('customer-', toString(number % 1000)), 'other', NULL, 'reported',
          'agent.search', 0, 0, toDecimal128('0.001', 18), 'priced', 1, 'success',
          'configured', 'reported', 'credits', toDecimal128('1', 18), 0,
          toDecimal128('0', 18), 0., 0, 365, 2555, '{}'
        FROM numbers(98304)
        SETTINGS max_threads = 8
      `,
      query_params: { prefix },
    });

    const builderId = `${prefix}17`;
    const explainRows = await rows<{ explain: string }>(`
      EXPLAIN indexes = 1
      SELECT count()
      FROM budget_cost_events_final
      WHERE payload_hash_count = 1
        AND builder_id = '${builderId}'
        AND timestamp >= toDateTime64('2026-02-01 00:00:00', 3, 'UTC')
        AND timestamp < toDateTime64('2026-02-02 00:00:00', 3, 'UTC')
    `);
    const plan = explainRows.map((row) => row.explain).join('\n');
    expect(plan).not.toContain('CreatingSets');
    expect(plan).toContain('PrimaryKey');
    expect(plan).toContain('builder_id');
    expect(plan).toContain('timestamp');
    const granules = [...plan.matchAll(/Granules:\s+(\d+)\/(\d+)/g)].map((match) => ({
      selected: Number(match[1]),
      total: Number(match[2]),
    }));
    expect(granules.some(({ selected, total }) => selected > 0 && selected < total)).toBe(true);

    const counts = await rows<{ count: number | string }>(
      `SELECT count() AS count
       FROM budget_cost_events_final
       WHERE payload_hash_count = 1
         AND builder_id = {builder:String}
         AND timestamp >= toDateTime64('2026-02-01 00:00:00', 3, 'UTC')
         AND timestamp < toDateTime64('2026-02-02 00:00:00', 3, 'UTC')`,
      { builder: builderId },
    );
    expect(Number(counts[0]?.count)).toBe(24);
  });

  it('proves lost-ack recovery against a durable real ClickHouse part', async () => {
    const builderId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const hash = 'c'.repeat(64);
    const payload = toolPayload({
      builder_id: builderId,
      event_id: eventId,
      reservation_decision_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      customer_id: `${builderId}:lost_ack_customer`,
    });
    const lease = projectionLease({
      builder_id: builderId,
      outbox_id: outboxId,
      event_id: eventId,
      payload_hash: hash,
      payload,
    });
    const lostAckTarget: BudgetProjectionTarget = {
      inspect: target.inspect,
      insert: async (value, payloadHash) => {
        await target.insert(value, payloadHash);
        throw new Error('simulated client acknowledgement loss after durable insert');
      },
    };
    const store = {
      renew: vi.fn(async (value) => ({
        ...value,
        lock_expires_at: '2026-07-14T09:13:12.000Z',
      })),
      markProjected: vi.fn(async () => true),
      releaseForRetry: vi.fn(async () => true),
    } as unknown as BudgetProjectionPostgresStore;

    await expect(
      __budgetProjectionWorkerTesting.processLease(store, lostAckTarget, lease),
    ).resolves.toBe('lost_ack_recovered');
    expect(store.markProjected).toHaveBeenCalledOnce();
    expect(store.releaseForRetry).not.toHaveBeenCalled();
    await expect(target.inspect(builderId, eventId, hash)).resolves.toMatchObject({
      state: 'matched',
      physical_rows: 1,
      logical_rows: 1,
    });
  });

  it('is idempotent when every ClickHouse DDL statement is applied twice', async () => {
    await expect(applyClickHouseMigrations(isolated)).resolves.toBeUndefined();
    const schema = await rows<{ engine: string; name: string }>(
      `SELECT name, engine FROM system.tables
       WHERE database = currentDatabase()
         AND name IN ('budget_cost_events', 'budget_cost_events_final', 'cost_events_with_control')
       ORDER BY name`,
    );
    expect(schema).toEqual([
      { name: 'budget_cost_events', engine: 'ReplacingMergeTree' },
      { name: 'budget_cost_events_final', engine: 'View' },
      { name: 'cost_events_with_control', engine: 'View' },
    ]);
  });
});
