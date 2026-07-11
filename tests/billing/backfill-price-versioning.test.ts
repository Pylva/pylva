import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  clickhouseCommand: vi.fn(),
  clickhouseQuery: vi.fn(),
  txExecute: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  clickhouse: {
    command: mocks.clickhouseCommand,
    query: mocks.clickhouseQuery,
  },
}));

vi.mock('../../src/lib/db/rls.js', () => ({ withRLS: mocks.withRLS }));
vi.mock('../../src/lib/auth/audit-log.js', () => ({ auditLog: mocks.auditLog }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { runBackfill } = await import('../../src/lib/pricing/backfill.js');

function jsonRows(rows: Array<Record<string, unknown>>) {
  return { json: vi.fn().mockResolvedValue(rows) };
}

const builderId = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withRLS.mockImplementation(
    async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb({ execute: mocks.txExecute }),
  );
  mocks.clickhouseCommand.mockResolvedValue(undefined);
});

describe('pricing backfill version windows', () => {
  it('backfills metric events on both sides of a price change with their historical rates', async () => {
    mocks.clickhouseQuery
      .mockResolvedValueOnce(
        jsonRows([
          {
            builder_id: builderId,
            provider: null,
            model: null,
            metric: 'search_query',
            min_ts: '2026-01-15 00:00:00',
            max_ts: '2026-02-15 00:00:00',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonRows([{ c: '0' }]));
    mocks.txExecute
      .mockResolvedValueOnce([
        {
          price_per_unit_usd: '0.01',
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: '2026-02-01T00:00:00.000Z',
        },
        {
          price_per_unit_usd: '0.02',
          effective_from: '2026-02-01T00:00:00.000Z',
          effective_to: null,
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(runBackfill()).resolves.toEqual({ groups: 1, updated: 1 });

    expect(mocks.clickhouseCommand).toHaveBeenCalledTimes(2);
    const [january, february] = mocks.clickhouseCommand.mock.calls.map(
      (call) => call[0] as { query: string; query_params: Record<string, unknown> },
    );
    expect(january?.query).toContain('timestamp >= parseDateTimeBestEffort({priceFrom:String})');
    expect(january?.query).toContain('timestamp < parseDateTimeBestEffort({priceTo:String})');
    expect(january?.query_params).toMatchObject({
      ppuUsd: 0.01,
      priceFrom: '2026-01-01T00:00:00.000Z',
      priceTo: '2026-02-01T00:00:00.000Z',
    });
    expect(february?.query_params).toMatchObject({
      ppuUsd: 0.02,
      priceFrom: '2026-02-01T00:00:00.000Z',
    });
    expect(february?.query_params).not.toHaveProperty('priceTo');
  });

  it('applies custom LLM windows before global windows so custom prices win', async () => {
    mocks.clickhouseQuery
      .mockResolvedValueOnce(
        jsonRows([
          {
            builder_id: builderId,
            provider: 'openai',
            model: 'gpt-test',
            metric: null,
            min_ts: '2026-01-15 00:00:00',
            max_ts: '2026-02-15 00:00:00',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonRows([{ c: '0' }]));
    mocks.txExecute
      .mockResolvedValueOnce([
        {
          input_per_1m_usd: '3',
          output_per_1m_usd: '6',
          price_per_unit_usd: null,
          effective_from: '2026-02-01T00:00:00.000Z',
          effective_to: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          input_per_1m: '1',
          output_per_1m: '2',
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: null,
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(runBackfill()).resolves.toEqual({ groups: 1, updated: 1 });

    expect(mocks.clickhouseCommand).toHaveBeenCalledTimes(2);
    const [custom, global] = mocks.clickhouseCommand.mock.calls.map(
      (call) => call[0] as { query: string; query_params: Record<string, unknown> },
    );
    expect(custom?.query).toContain('AND isNull(metric)');
    expect(custom?.query_params).toMatchObject({
      inUsd: 3,
      outUsd: 6,
      priceFrom: '2026-02-01T00:00:00.000Z',
    });
    expect(global?.query_params).toMatchObject({
      inUsd: 1,
      outUsd: 2,
      priceFrom: '2026-01-01T00:00:00.000Z',
      priceTo: '2026-02-01T00:00:00.000Z',
    });
  });
});
