import { describe, expect, it, vi } from 'vitest';
import {
  checkClickHouseReadiness,
  REQUIRED_AUTHORITATIVE_TABLE_CONTRACTS,
  REQUIRED_BUDGET_COST_EVENT_COLUMNS,
  REQUIRED_CLICKHOUSE_TABLES,
  REQUIRED_COST_EVENTS_COLUMN_TYPES,
  REQUIRED_COST_EVENTS_COLUMNS,
} from '../../src/lib/clickhouse/readiness.js';

function healthyMetadataRows(): Array<Record<string, unknown>> {
  return [
    ...REQUIRED_CLICKHOUSE_TABLES.map((name) => {
      const contract =
        REQUIRED_AUTHORITATIVE_TABLE_CONTRACTS[
          name as keyof typeof REQUIRED_AUTHORITATIVE_TABLE_CONTRACTS
        ];
      return {
        kind: 'table',
        name,
        ...(contract
          ? {
              engine: contract.engine,
              sorting_key: contract.sortingKey,
              primary_key: contract.primaryKey,
              definition: contract.definitionFragments.join(' '),
            }
          : {}),
      };
    }),
    ...REQUIRED_COST_EVENTS_COLUMNS.map((name) => ({
      kind: 'column',
      name,
      type: REQUIRED_COST_EVENTS_COLUMN_TYPES[
        name as keyof typeof REQUIRED_COST_EVENTS_COLUMN_TYPES
      ],
    })),
    ...Object.entries(REQUIRED_BUDGET_COST_EVENT_COLUMNS).map(([name, type]) => ({
      kind: 'budget_column',
      name,
      type,
    })),
  ];
}

function clientReturning(rows: Array<Record<string, unknown>>) {
  return {
    query: vi.fn(async () => ({
      json: async () => rows,
    })),
  };
}

describe('checkClickHouseReadiness', () => {
  it('requires launch tables and cost_events columns', async () => {
    const client = clientReturning(healthyMetadataRows());

    const result = await checkClickHouseReadiness(client);

    expect(result.ready).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: {
          tables: [...REQUIRED_CLICKHOUSE_TABLES],
          columns: [...REQUIRED_COST_EVENTS_COLUMNS],
          budget_columns: Object.keys(REQUIRED_BUDGET_COST_EVENT_COLUMNS),
        },
        format: 'JSONEachRow',
      }),
    );
  });

  it('marks readiness degraded when model aggregate data has not been verified', async () => {
    const client = clientReturning([
      ...healthyMetadataRows(),
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
      ...healthyMetadataRows(),
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

  it('rejects a server-timezone-dependent legacy event timestamp', async () => {
    const rows = healthyMetadataRows();
    const timestamp = rows.find((row) => row.kind === 'column' && row.name === 'timestamp');
    timestamp!.type = 'DateTime';

    const result = await checkClickHouseReadiness(clientReturning(rows));

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'clickhouse.cost_events_schema',
          ok: false,
          missing: ['cost_events.timestamp.type'],
        }),
      ]),
    );
  });

  it('rejects a stale authoritative sort key even when every object name exists', async () => {
    const rows = healthyMetadataRows();
    const table = rows.find((row) => row.kind === 'table' && row.name === 'budget_cost_events');
    table!.sorting_key = 'builder_id, event_id, payload_hash';
    table!.primary_key = 'builder_id, event_id, payload_hash';

    const result = await checkClickHouseReadiness(clientReturning(rows));

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'clickhouse.authoritative_budget_schema',
          ok: false,
          missing: expect.arrayContaining([
            'budget_cost_events.sorting_key',
            'budget_cost_events.primary_key',
          ]),
        }),
      ]),
    );
  });

  it('rejects a canonical view that restores the global identity-set scan', async () => {
    const rows = healthyMetadataRows();
    const view = rows.find(
      (row) => row.kind === 'table' && row.name === 'budget_cost_events_final',
    );
    view!.definition = `${String(view!.definition)} WHERE (builder_id, event_id) IN (SELECT 1)`;

    const result = await checkClickHouseReadiness(clientReturning(rows));

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'clickhouse.authoritative_budget_schema',
          missing: expect.arrayContaining(['budget_cost_events_final.global_identity_set']),
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
