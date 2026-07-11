// /api/v1/health exposes aggregate dependency status PLUS the deployed build
// SHA (`version`), which the verify-deploy skill compares against origin/main.
// The version field must be present on BOTH the healthy (200) and degraded
// (503) responses so a deploy can be checked even while a dependency is down.

import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  REQUIRED_CLICKHOUSE_TABLES,
  REQUIRED_COST_EVENTS_COLUMNS,
} from '../../src/lib/clickhouse/readiness.js';

type TestSchemaStatus = {
  expected_head: string;
  applied_head: string | null;
  pending_count: number | null;
  state: 'in_sync' | 'behind' | 'drift' | 'untracked' | 'unavailable';
};

const mocks = vi.hoisted(() => ({
  clickhouseRows: { value: [] as Array<Record<string, unknown>> },
  redisUp: { value: true },
  schemaStatus: {
    value: {
      expected_head: '003_test.sql',
      applied_head: '003_test.sql',
      pending_count: 0,
      state: 'in_sync' as const,
    } as TestSchemaStatus,
  },
  warn: vi.fn(),
}));

vi.mock('../../src/lib/db/client.js', () => ({
  sql: () => Promise.resolve([{ ok: 1 }]),
}));
vi.mock('../../src/lib/clickhouse/client.js', () => ({
  clickhouse: {
    query: () => Promise.resolve({ json: () => Promise.resolve(mocks.clickhouseRows.value) }),
  },
}));
vi.mock('../../src/lib/redis/client.js', () => ({
  pingRedis: () => Promise.resolve(mocks.redisUp.value),
}));
vi.mock('../../src/lib/db/schema-status.js', () => ({
  getSchemaStatus: () => Promise.resolve(mocks.schemaStatus.value),
}));
vi.mock('../../src/lib/config.js', () => ({
  env: { SENTRY_RELEASE: 'abc1234' },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ warn: mocks.warn }),
  },
}));

const { GET } = await import('../../src/app/api/v1/health/route.js');

describe('GET /api/v1/health', () => {
  beforeEach(() => {
    mocks.clickhouseRows.value = [
      ...REQUIRED_CLICKHOUSE_TABLES.map((name) => ({ kind: 'table', name })),
      ...REQUIRED_COST_EVENTS_COLUMNS.map((name) => ({ kind: 'column', name })),
    ];
    mocks.redisUp.value = true;
    mocks.schemaStatus.value = {
      expected_head: '003_test.sql',
      applied_head: '003_test.sql',
      pending_count: 0,
      state: 'in_sync',
    };
    mocks.warn.mockClear();
  });

  it('reports healthy + the deployed version when all deps are up', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('abc1234');
    expect(body.services).toEqual({
      postgresql: 'up',
      clickhouse: 'up',
      redis: 'up',
    });
  });

  it('includes schema status on the healthy response body', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schema).toEqual({
      expected_head: '003_test.sql',
      applied_head: '003_test.sql',
      pending_count: 0,
      state: 'in_sync',
    });
  });

  it('keeps HTTP status healthy when schema status is behind', async () => {
    mocks.schemaStatus.value = {
      expected_head: '004_test.sql',
      applied_head: '001_test.sql',
      pending_count: 3,
      state: 'behind',
    };

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.schema).toEqual({
      expected_head: '004_test.sql',
      applied_head: '001_test.sql',
      pending_count: 3,
      state: 'behind',
    });
  });

  it('keeps HTTP status healthy when schema status is drift', async () => {
    mocks.schemaStatus.value = {
      expected_head: '004_test.sql',
      applied_head: '004_test.sql',
      pending_count: 0,
      state: 'drift',
    };

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.schema).toEqual({
      expected_head: '004_test.sql',
      applied_head: '004_test.sql',
      pending_count: 0,
      state: 'drift',
    });
  });

  it('keeps HTTP status healthy when schema status is untracked', async () => {
    mocks.schemaStatus.value = {
      expected_head: '004_test.sql',
      applied_head: null,
      pending_count: null,
      state: 'untracked',
    };

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.schema).toEqual({
      expected_head: '004_test.sql',
      applied_head: null,
      pending_count: null,
      state: 'untracked',
    });
  });

  it('still carries version on the degraded (503) response', async () => {
    mocks.redisUp.value = false;
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('degraded');
    expect(body.version).toBe('abc1234');
  });

  it('keeps existing degraded semantics when redis is down and schema is unavailable', async () => {
    mocks.redisUp.value = false;
    mocks.schemaStatus.value = {
      expected_head: '004_test.sql',
      applied_head: null,
      pending_count: null,
      state: 'unavailable',
    };

    const response = await GET();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('degraded');
    expect(body.version).toBe('abc1234');
    expect(body.services).toEqual({
      postgresql: 'up',
      clickhouse: 'up',
      redis: 'down',
    });
    expect(body.schema).toEqual({
      expected_head: '004_test.sql',
      applied_head: null,
      pending_count: null,
      state: 'unavailable',
    });
  });

  it('marks ClickHouse down when the required cost_events table is missing', async () => {
    mocks.clickhouseRows.value = [
      { kind: 'table', name: 'cost_daily_agg_v2' },
      ...REQUIRED_COST_EVENTS_COLUMNS.map((name) => ({ kind: 'column', name })),
    ];
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('degraded');
    expect(body.services.clickhouse).toBe('down');
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failed_checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'clickhouse.tables',
            missing: expect.arrayContaining(['cost_events']),
          }),
        ]),
      }),
      'clickhouse readiness check failed',
    );
  });

  it('marks ClickHouse down when required launch columns are missing', async () => {
    mocks.clickhouseRows.value = [
      ...REQUIRED_CLICKHOUSE_TABLES.map((name) => ({ kind: 'table', name })),
      { kind: 'column', name: 'builder_id' },
    ];
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.services.clickhouse).toBe('down');
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failed_checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'clickhouse.cost_events_columns',
            missing: expect.arrayContaining(['customer_id', 'pricing_status']),
          }),
        ]),
      }),
      'clickhouse readiness check failed',
    );
  });

  it('marks ClickHouse down when model aggregate backfill is unverified and raw events exist', async () => {
    mocks.clickhouseRows.value = [
      ...REQUIRED_CLICKHOUSE_TABLES.map((name) => ({ kind: 'table', name })),
      ...REQUIRED_COST_EVENTS_COLUMNS.map((name) => ({ kind: 'column', name })),
      { kind: 'cost_events_presence', name: 'present' },
      { kind: 'model_agg_status', name: 'untrusted' },
    ];

    const response = await GET();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.services.clickhouse).toBe('down');
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failed_checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'clickhouse.model_daily_agg_backfill',
            message: expect.stringContaining('cost_model_daily_agg'),
          }),
        ]),
      }),
      'clickhouse readiness check failed',
    );
  });
});
