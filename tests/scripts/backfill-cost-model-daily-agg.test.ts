import { describe, expect, it, vi } from 'vitest';
import { main } from '../../scripts/backfill-cost-model-daily-agg.js';

interface CapturedCommand {
  query: string;
  query_params?: Record<string, unknown>;
  clickhouse_settings?: Record<string, unknown>;
}

interface CapturedQuery {
  query: string;
  query_params?: Record<string, unknown>;
  format: 'JSONEachRow';
}

const SAFE_ENV = {
  CLICKHOUSE_URL: 'http://clickhouse.test:8123',
  CONFIRM_COST_EVENTS_INGEST_PAUSED: 'true',
};

const MATCHING_TOTALS = {
  cost_usd: '12.345678',
  tokens_in: '100',
  tokens_out: '50',
  call_count: '5',
};

function createMockClient(
  options: {
    failOnCommand?: (query: string) => boolean;
    latestStatus?: 'trusted' | 'untrusted' | null;
    sourceTotals?: typeof MATCHING_TOTALS;
    aggregateTotals?: typeof MATCHING_TOTALS;
  } = {},
) {
  const commands: CapturedCommand[] = [];
  const queries: CapturedQuery[] = [];
  const client = {
    command: vi.fn(async (command: CapturedCommand) => {
      commands.push(command);
      if (options.failOnCommand?.(command.query)) throw new Error('insert failed');
    }),
    query: vi.fn(async (query: CapturedQuery) => {
      queries.push(query);
      if (query.query.includes('FROM cost_model_daily_agg_backfill_status')) {
        const latestStatus = options.latestStatus ?? 'trusted';
        return { json: async () => (latestStatus ? [{ status: latestStatus }] : []) };
      }
      if (query.query.includes('FROM cost_events')) {
        return { json: async () => [options.sourceTotals ?? MATCHING_TOTALS] };
      }
      if (query.query.includes('FROM cost_model_daily_agg')) {
        return { json: async () => [options.aggregateTotals ?? MATCHING_TOTALS] };
      }
      return { json: async () => [] };
    }),
    close: vi.fn(async () => {}),
  };
  return { client, commands, queries };
}

describe('backfill-cost-model-daily-agg', () => {
  it('refuses to run unless cost_events ingest is explicitly paused', async () => {
    const { client } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await expect(
      main({
        argv: ['node', 'scripts/backfill-cost-model-daily-agg.ts'],
        env: {},
        clientFactory,
      }),
    ).rejects.toThrow('Pause telemetry ingest');

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rewrites and verifies the full aggregate before marking it trusted', async () => {
    const { client, commands, queries } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await main({
      argv: ['node', 'scripts/backfill-cost-model-daily-agg.ts'],
      env: SAFE_ENV,
      clientFactory,
      stdout: { log: vi.fn() },
    });

    expect(clientFactory).toHaveBeenCalledWith({ url: 'http://clickhouse.test:8123' });
    expect(commands[0]?.query).toContain('INSERT INTO cost_model_daily_agg_backfill_status');
    expect(commands[0]?.query_params).toMatchObject({
      scope: 'full',
      status: 'untrusted',
      reason: 'full_backfill_started',
    });
    expect(commands[1]?.query).toBe('TRUNCATE TABLE cost_model_daily_agg');
    expect(commands[2]?.query).toContain('INSERT INTO cost_model_daily_agg');
    expect(commands[2]?.query).toContain('FROM cost_events');
    expect(commands[2]?.query).toContain('is_demo');
    expect(commands[2]?.query).toContain('sum(tokens_in) AS total_tokens_in');
    expect(commands[2]?.query).toContain('sum(tokens_out) AS total_tokens_out');
    expect(commands[2]?.query).toContain('count() AS call_count');
    expect(commands[2]?.query).toContain('max(billing_retention_days) AS billing_retention_days');
    expect(commands[2]?.query).toContain('GROUP BY day, builder_id, is_demo, provider, model');
    expect(queries.some((query) => query.query.includes('FROM cost_events'))).toBe(true);
    expect(queries.some((query) => query.query.includes('FROM cost_model_daily_agg'))).toBe(true);
    expect(commands[3]?.query).toContain('INSERT INTO cost_model_daily_agg_backfill_status');
    expect(commands[3]?.query_params).toMatchObject({
      scope: 'full',
      status: 'trusted',
      reason: 'full_backfill_verified',
      source_cost_usd: '12.345678',
      aggregate_cost_usd: '12.345678',
      source_call_count: '5',
      aggregate_call_count: '5',
    });
    expect(commands.map((command) => command.query).join('\n')).not.toContain('DROP VIEW');
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('rewrites one aggregate day and preserves existing aggregate trust', async () => {
    const { client, commands } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await main({
      argv: ['node', 'scripts/backfill-cost-model-daily-agg.ts', '2026-06-27'],
      env: SAFE_ENV,
      clientFactory,
      stdout: { log: vi.fn() },
    });

    expect(commands[0]?.query_params).toMatchObject({
      scope: 'day',
      status: 'untrusted',
      reason: 'day_backfill_started',
      day: '2026-06-27',
    });
    expect(commands[1]).toMatchObject({
      query: 'ALTER TABLE cost_model_daily_agg DELETE WHERE day = toDate({day:String})',
      query_params: { day: '2026-06-27' },
      clickhouse_settings: { mutations_sync: '1' },
    });
    expect(commands[2]?.query).toContain('INSERT INTO cost_model_daily_agg');
    expect(commands[2]?.query).toContain('WHERE toDate(timestamp) = toDate({day:String})');
    expect(commands[2]?.query_params).toEqual({ day: '2026-06-27' });
    expect(commands[3]?.query_params).toMatchObject({
      scope: 'day',
      status: 'trusted',
      reason: 'day_backfill_verified',
      day: '2026-06-27',
    });
    expect(commands.map((command) => command.query)).not.toContain(
      'TRUNCATE TABLE cost_model_daily_agg',
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('does not let a day backfill promote an untrusted full aggregate', async () => {
    const { client, commands } = createMockClient({ latestStatus: 'untrusted' });
    const clientFactory = vi.fn(() => client);

    await main({
      argv: ['node', 'scripts/backfill-cost-model-daily-agg.ts', '2026-06-27'],
      env: SAFE_ENV,
      clientFactory,
      stdout: { log: vi.fn() },
    });

    expect(commands.at(-1)?.query).toContain('INSERT INTO cost_model_daily_agg_backfill_status');
    expect(commands.at(-1)?.query_params).toMatchObject({
      scope: 'day',
      status: 'untrusted',
      reason: 'day_backfill_verified_but_full_backfill_untrusted',
      day: '2026-06-27',
    });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('marks the aggregate untrusted when verification fails', async () => {
    const { client, commands } = createMockClient({
      aggregateTotals: { ...MATCHING_TOTALS, call_count: '4' },
    });
    const clientFactory = vi.fn(() => client);

    await expect(
      main({
        argv: ['node', 'scripts/backfill-cost-model-daily-agg.ts'],
        env: SAFE_ENV,
        clientFactory,
        stdout: { log: vi.fn() },
      }),
    ).rejects.toThrow('verification failed');

    expect(commands.at(-1)?.query).toContain('INSERT INTO cost_model_daily_agg_backfill_status');
    expect(commands.at(-1)?.query_params).toMatchObject({
      scope: 'full',
      status: 'untrusted',
      reason: 'full_backfill_verification_failed',
      source_call_count: '5',
      aggregate_call_count: '4',
    });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('closes the ClickHouse client when the rewrite fails', async () => {
    const { client, commands } = createMockClient({
      failOnCommand: (query) => query.includes('INSERT INTO cost_model_daily_agg\n'),
    });
    const clientFactory = vi.fn(() => client);

    await expect(
      main({
        argv: ['node', 'scripts/backfill-cost-model-daily-agg.ts'],
        env: SAFE_ENV,
        clientFactory,
        stdout: { log: vi.fn() },
      }),
    ).rejects.toThrow('insert failed');

    expect(commands.at(-1)?.query).toContain('INSERT INTO cost_model_daily_agg');
    expect(commands[0]?.query_params).toMatchObject({
      scope: 'full',
      status: 'untrusted',
      reason: 'full_backfill_started',
    });
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
