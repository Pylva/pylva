import { describe, expect, it, vi } from 'vitest';
import { main } from '../../scripts/backfill-cost-daily-agg-v2.js';

interface CapturedCommand {
  query: string;
  query_params?: Record<string, unknown>;
  clickhouse_settings?: Record<string, unknown>;
}

const SAFE_ENV = {
  CLICKHOUSE_URL: 'http://clickhouse.test:8123',
  CONFIRM_COST_EVENTS_INGEST_PAUSED: 'true',
};

function createMockClient(failOnQuery?: (query: string) => boolean) {
  const commands: CapturedCommand[] = [];
  const client = {
    command: vi.fn(async (command: CapturedCommand) => {
      commands.push(command);
      if (failOnQuery?.(command.query)) throw new Error('insert failed');
    }),
    close: vi.fn(async () => {}),
  };
  return { client, commands };
}

describe('backfill-cost-daily-agg-v2', () => {
  it('refuses to run unless cost_events ingest is explicitly paused', async () => {
    const { client } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await expect(
      main({
        argv: ['node', 'scripts/backfill-cost-daily-agg-v2.ts'],
        env: {},
        clientFactory,
      }),
    ).rejects.toThrow('Pause telemetry ingest');

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('drops the materialized view around a full aggregate rewrite', async () => {
    const { client, commands } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await main({
      argv: ['node', 'scripts/backfill-cost-daily-agg-v2.ts'],
      env: SAFE_ENV,
      clientFactory,
      stdout: { log: vi.fn() },
    });

    expect(clientFactory).toHaveBeenCalledWith({ url: 'http://clickhouse.test:8123' });
    expect(commands[0]?.query).toBe('DROP VIEW IF EXISTS cost_daily_agg_v2_mv SYNC');
    expect(commands[1]?.query).toBe('TRUNCATE TABLE cost_daily_agg_v2');
    expect(commands[2]?.query).toContain('INSERT INTO cost_daily_agg_v2');
    expect(commands[2]?.query).toContain('FROM cost_events');
    expect(commands[2]?.query).toContain('billing_retention_days');
    expect(commands[2]?.query).toContain('sum(ifNull(cost_usd, toDecimal64(0, 6)))');
    expect(commands[2]?.query).toContain('avg(latency_ms) AS avg_latency_ms');
    expect(commands[2]?.query).toContain(
      'GROUP BY builder_id, customer_id, day, provider, model, step_name, billing_retention_days',
    );
    expect(commands[3]?.query).toContain(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily_agg_v2_mv',
    );
    expect(commands[3]?.query).toContain('TO cost_daily_agg_v2');
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('drops the materialized view around a per-day aggregate rewrite', async () => {
    const { client, commands } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await main({
      argv: ['node', 'scripts/backfill-cost-daily-agg-v2.ts', '2026-06-27'],
      env: SAFE_ENV,
      clientFactory,
      stdout: { log: vi.fn() },
    });

    expect(commands[0]?.query).toBe('DROP VIEW IF EXISTS cost_daily_agg_v2_mv SYNC');
    expect(commands[1]).toMatchObject({
      query: 'ALTER TABLE cost_daily_agg_v2 DELETE WHERE day = toDate({day:String})',
      query_params: { day: '2026-06-27' },
      clickhouse_settings: { mutations_sync: '1' },
    });
    expect(commands[2]?.query).toContain('INSERT INTO cost_daily_agg_v2');
    expect(commands[2]?.query).toContain('WHERE toDate(timestamp) = toDate({day:String})');
    expect(commands[2]?.query_params).toEqual({ day: '2026-06-27' });
    expect(commands[3]?.query).toContain(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily_agg_v2_mv',
    );
    expect(commands.map((command) => command.query)).not.toContain(
      'TRUNCATE TABLE cost_daily_agg_v2',
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('recreates the materialized view when the rewrite fails', async () => {
    const { client, commands } = createMockClient((query) => query.includes('INSERT INTO'));
    const clientFactory = vi.fn(() => client);

    await expect(
      main({
        argv: ['node', 'scripts/backfill-cost-daily-agg-v2.ts'],
        env: SAFE_ENV,
        clientFactory,
        stdout: { log: vi.fn() },
      }),
    ).rejects.toThrow('insert failed');

    expect(commands.at(-1)?.query).toContain(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily_agg_v2_mv',
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
