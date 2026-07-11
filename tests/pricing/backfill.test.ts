import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STORABLE_COST_USD } from '../../src/lib/clickhouse/decimal-limits.js';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  clickhouseCommand: vi.fn(),
  clickhouseQuery: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  txExecute: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  clickhouse: {
    command: mocks.clickhouseCommand,
    query: mocks.clickhouseQuery,
  },
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      error: mocks.logError,
      info: mocks.logInfo,
      warn: mocks.logWarn,
    }),
  },
}));

const { runBackfill } = await import('../../src/lib/pricing/backfill.js');

function jsonRows(rows: Array<Record<string, unknown>>) {
  return { json: vi.fn().mockResolvedValue(rows) };
}

function sqlText(callIndex: number): string {
  return JSON.stringify(mocks.txExecute.mock.calls[callIndex]?.[0]);
}

const metricGroup = {
  builder_id: '00000000-0000-4000-8000-000000000001',
  provider: null,
  model: null,
  metric: 'search_query',
  min_ts: '2026-04-18 10:00:00',
  max_ts: '2026-04-18 10:00:00',
};

const llmGroup = {
  builder_id: '00000000-0000-4000-8000-000000000001',
  provider: 'openai',
  model: 'gpt-4o',
  metric: null,
  min_ts: '2026-04-18 10:00:00',
  max_ts: '2026-04-18 10:00:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withRLS.mockImplementation(
    async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb({ execute: mocks.txExecute }),
  );
  mocks.clickhouseCommand.mockResolvedValue(undefined);
});

describe('pricing backfill Decimal(10,6) guards', () => {
  it('guards metric backfill updates and leaves onboarding open when pending rows remain', async () => {
    mocks.clickhouseQuery
      .mockResolvedValueOnce(jsonRows([metricGroup]))
      .mockResolvedValueOnce(jsonRows([{ c: '1' }]));
    mocks.txExecute.mockResolvedValueOnce([
      {
        price_per_unit_usd: '0.2',
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: null,
      },
    ]);

    await expect(runBackfill()).resolves.toEqual({ groups: 1, updated: 1 });

    const command = mocks.clickhouseCommand.mock.calls[0]?.[0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(command.query).toContain('cost_usd = round(metric_value * {ppuUsd:Float64}, 6)');
    expect(command.query).toContain('AND metric_value * {ppuUsd:Float64} >= 0');
    expect(command.query).toContain('AND metric_value * {ppuUsd:Float64} <= {maxCostUsd:Float64}');
    expect(command.query_params).toMatchObject({
      maxCostUsd: MAX_STORABLE_COST_USD,
      metric: 'search_query',
      ppuUsd: 0.2,
    });
    expect(sqlText(0)).toContain('FROM custom_pricing');
    expect(sqlText(0)).toContain('builder_id =');
    expect(mocks.auditLog).not.toHaveBeenCalled();
    expect(mocks.txExecute).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'search_query' }),
      expect.stringContaining('left metric rows pending'),
    );
  });

  it('resolves onboarding after metric backfill only when no pending rows remain', async () => {
    mocks.clickhouseQuery
      .mockResolvedValueOnce(jsonRows([metricGroup]))
      .mockResolvedValueOnce(jsonRows([{ c: '0' }]));
    mocks.txExecute
      .mockResolvedValueOnce([
        {
          price_per_unit_usd: '0.01',
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: null,
        },
      ])
      .mockResolvedValueOnce([{ id: 'task-1' }]);

    await expect(runBackfill()).resolves.toEqual({ groups: 1, updated: 1 });

    expect(mocks.txExecute).toHaveBeenCalledTimes(2);
    expect(sqlText(1)).toContain('UPDATE pricing_onboarding_tasks');
    expect(sqlText(1)).toContain('builder_id =');
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'onboarding.resolved',
        resource_id: 'task-1',
      }),
    );
  });

  it('guards LLM backfill updates with the same max bound', async () => {
    mocks.clickhouseQuery
      .mockResolvedValueOnce(jsonRows([llmGroup]))
      .mockResolvedValueOnce(jsonRows([{ c: '1' }]));
    mocks.txExecute
      .mockResolvedValueOnce([
        {
          input_per_1m_usd: '0',
          output_per_1m_usd: '1000',
          price_per_unit_usd: null,
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: null,
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(runBackfill()).resolves.toEqual({ groups: 1, updated: 1 });

    const command = mocks.clickhouseCommand.mock.calls[0]?.[0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(command.query).toContain(
      'cost_usd = round((tokens_in * {inUsd:Float64} + tokens_out * {outUsd:Float64}) / 1000000, 6)',
    );
    expect(command.query).toContain(
      'AND (tokens_in * {inUsd:Float64} + tokens_out * {outUsd:Float64}) / 1000000 >= 0',
    );
    expect(command.query).toContain(
      'AND (tokens_in * {inUsd:Float64} + tokens_out * {outUsd:Float64}) / 1000000 <= {maxCostUsd:Float64}',
    );
    expect(command.query_params).toMatchObject({
      inUsd: 0,
      maxCostUsd: MAX_STORABLE_COST_USD,
      model: 'gpt-4o',
      outUsd: 1000,
      provider: 'openai',
    });
    expect(sqlText(0)).toContain('FROM custom_pricing');
    expect(sqlText(0)).toContain('builder_id =');
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('treats provider=other plus model as a real LLM pricing key', async () => {
    const otherProviderGroup = {
      ...llmGroup,
      provider: 'other',
      model: 'ollama/llama3.1-8b',
    };
    mocks.clickhouseQuery
      .mockResolvedValueOnce(jsonRows([otherProviderGroup]))
      .mockResolvedValueOnce(jsonRows([{ c: '1' }]));
    mocks.txExecute
      .mockResolvedValueOnce([
        {
          input_per_1m_usd: '0.6',
          output_per_1m_usd: '0.8',
          price_per_unit_usd: null,
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: null,
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(runBackfill()).resolves.toEqual({ groups: 1, updated: 1 });

    const command = mocks.clickhouseCommand.mock.calls[0]?.[0] as {
      query_params: Record<string, unknown>;
    };
    expect(command.query_params).toMatchObject({
      provider: 'other',
      model: 'ollama/llama3.1-8b',
      inUsd: 0.6,
      outUsd: 0.8,
    });
    expect(sqlText(0)).toContain('provider =');
    expect(sqlText(0)).toContain('model =');
  });
});
