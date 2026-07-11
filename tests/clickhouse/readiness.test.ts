import { describe, expect, it, vi } from 'vitest';
import {
  checkClickHouseReadiness,
  REQUIRED_CLICKHOUSE_TABLES,
  REQUIRED_COST_EVENTS_COLUMNS,
} from '../../src/lib/clickhouse/readiness.js';

function clientReturning(rows: Array<Record<string, unknown>>) {
  return {
    query: vi.fn(async () => ({
      json: async () => rows,
    })),
  };
}

describe('checkClickHouseReadiness', () => {
  it('requires launch tables and cost_events columns', async () => {
    const client = clientReturning([
      ...REQUIRED_CLICKHOUSE_TABLES.map((name) => ({ kind: 'table', name })),
      ...REQUIRED_COST_EVENTS_COLUMNS.map((name) => ({ kind: 'column', name })),
    ]);

    const result = await checkClickHouseReadiness(client);

    expect(result.ready).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: {
          tables: [...REQUIRED_CLICKHOUSE_TABLES],
          columns: [...REQUIRED_COST_EVENTS_COLUMNS],
        },
        format: 'JSONEachRow',
      }),
    );
  });

  it('marks readiness degraded when model aggregate data has not been verified', async () => {
    const client = clientReturning([
      ...REQUIRED_CLICKHOUSE_TABLES.map((name) => ({ kind: 'table', name })),
      ...REQUIRED_COST_EVENTS_COLUMNS.map((name) => ({ kind: 'column', name })),
      { kind: 'cost_events_presence', name: 'present' },
      { kind: 'model_agg_status', name: 'untrusted' },
    ]);

    const result = await checkClickHouseReadiness(client);

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'clickhouse.model_daily_agg_backfill',
          ok: false,
          message: expect.stringContaining('cost_model_daily_agg'),
        }),
      ]),
    );
  });

  it('allows missing model aggregate verification when there are no raw events yet', async () => {
    const client = clientReturning([
      ...REQUIRED_CLICKHOUSE_TABLES.map((name) => ({ kind: 'table', name })),
      ...REQUIRED_COST_EVENTS_COLUMNS.map((name) => ({ kind: 'column', name })),
      { kind: 'cost_events_presence', name: 'empty' },
      { kind: 'model_agg_status', name: 'missing' },
    ]);

    const result = await checkClickHouseReadiness(client);

    expect(result.ready).toBe(true);
  });

  it('reports missing tables and columns', async () => {
    const client = clientReturning([
      { kind: 'table', name: 'cost_events' },
      { kind: 'column', name: 'builder_id' },
    ]);

    const result = await checkClickHouseReadiness(client);

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'clickhouse.tables',
          missing: expect.arrayContaining([
            'cost_daily_agg_v2',
            'cost_customer_daily_agg',
            'cost_model_daily_agg',
            'cost_model_daily_agg_backfill_status',
          ]),
        }),
        expect.objectContaining({
          name: 'clickhouse.cost_events_columns',
          missing: expect.arrayContaining(['customer_id', 'pricing_status', 'is_demo']),
        }),
      ]),
    );
  });

  it('sanitizes connection errors', async () => {
    const client = {
      query: vi.fn(async () => {
        throw new Error(
          'Auth failed url=https://user:secret@clickhouse.example.com password=hunter2',
        );
      }),
    };

    const result = await checkClickHouseReadiness(client);

    expect(result.ready).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: 'clickhouse.responds',
      ok: false,
    });
    expect(result.checks[0]?.message).not.toContain('hunter2');
    expect(result.checks[0]?.message).not.toContain('user:secret');
  });
});
