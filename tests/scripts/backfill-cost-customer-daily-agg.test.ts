import { describe, expect, it, vi } from 'vitest';
import { main } from '../../scripts/backfill-cost-customer-daily-agg.js';

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

describe('backfill-cost-customer-daily-agg', () => {
  it('refuses to run unless cost_events ingest is explicitly paused', async () => {
    const { client } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await expect(
      main({
        argv: ['node', 'scripts/backfill-cost-customer-daily-agg.ts'],
        env: {},
        clientFactory,
      }),
    ).rejects.toThrow('Pause telemetry ingest');

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rewrites the full aggregate without dropping the materialized view', async () => {
    const { client, commands } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await main({
      argv: ['node', 'scripts/backfill-cost-customer-daily-agg.ts'],
      env: SAFE_ENV,
      clientFactory,
      stdout: { log: vi.fn() },
    });

    expect(clientFactory).toHaveBeenCalledWith({ url: 'http://clickhouse.test:8123' });
    expect(commands[0]?.query).toBe('TRUNCATE TABLE cost_customer_daily_agg');
    expect(commands[1]?.query).toContain('INSERT INTO cost_customer_daily_agg');
    expect(commands[1]?.query).toContain('FROM cost_events');
    expect(commands[1]?.query).toContain(
      "CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)'",
    );
    expect(commands[1]?.query).toContain('max(billing_retention_days) AS billing_retention_days');
    expect(commands.map((command) => command.query)).not.toContain(
      'DROP VIEW IF EXISTS cost_customer_daily_agg_mv SYNC',
    );
    expect(commands.map((command) => command.query).join('\n')).not.toContain(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS cost_customer_daily_agg_mv',
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('rewrites one aggregate day without dropping the materialized view', async () => {
    const { client, commands } = createMockClient();
    const clientFactory = vi.fn(() => client);

    await main({
      argv: ['node', 'scripts/backfill-cost-customer-daily-agg.ts', '2026-06-27'],
      env: SAFE_ENV,
      clientFactory,
      stdout: { log: vi.fn() },
    });

    expect(commands[0]).toMatchObject({
      query: 'ALTER TABLE cost_customer_daily_agg DELETE WHERE day = toDate({day:String})',
      query_params: { day: '2026-06-27' },
      clickhouse_settings: { mutations_sync: '1' },
    });
    expect(commands[1]?.query).toContain('INSERT INTO cost_customer_daily_agg');
    expect(commands[1]?.query).toContain('WHERE toDate(timestamp) = toDate({day:String})');
    expect(commands[1]?.query).toContain('max(billing_retention_days) AS billing_retention_days');
    expect(commands[1]?.query_params).toEqual({ day: '2026-06-27' });
    expect(commands.map((command) => command.query)).not.toContain(
      'TRUNCATE TABLE cost_customer_daily_agg',
    );
    expect(commands.map((command) => command.query)).not.toContain(
      'DROP VIEW IF EXISTS cost_customer_daily_agg_mv SYNC',
    );
    expect(commands.map((command) => command.query).join('\n')).not.toContain(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS cost_customer_daily_agg_mv',
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('closes the ClickHouse client when the rewrite fails', async () => {
    const { client, commands } = createMockClient((query) => query.includes('INSERT INTO'));
    const clientFactory = vi.fn(() => client);

    await expect(
      main({
        argv: ['node', 'scripts/backfill-cost-customer-daily-agg.ts'],
        env: SAFE_ENV,
        clientFactory,
        stdout: { log: vi.fn() },
      }),
    ).rejects.toThrow('insert failed');

    expect(commands.at(-1)?.query).toContain('INSERT INTO cost_customer_daily_agg');
    expect(commands.map((command) => command.query).join('\n')).not.toContain(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS cost_customer_daily_agg_mv',
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
