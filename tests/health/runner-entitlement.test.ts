import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  authorizeBuilderCapability: vi.fn(),
  deliverBuilderAlert: vi.fn(),
  getBuilderEntitlementForShare: vi.fn(),
  queryCostEvents: vi.fn(),
  statusExecute: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/db/client.js', () => ({
  db: { execute: mocks.dbExecute },
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: mocks.authorizeBuilderCapability,
}));

vi.mock('../../src/lib/db/advisory-locks.js', () => ({
  getBuilderEntitlementForShare: mocks.getBuilderEntitlementForShare,
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: mocks.queryCostEvents,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/alerts/builder-alert.js', () => ({
  deliverBuilderAlert: mocks.deliverBuilderAlert,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    warn: vi.fn(),
  },
}));

const { runHealthCheck } = await import('../../src/lib/health/runner.js');

const NOW = new Date('2026-04-25T12:00:00.000Z');

function denseAggregateRows() {
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(NOW.getTime() - (29 - index) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return {
      day,
      provider: 'openai',
      metric: null,
      event_count: '100',
      cost_usd: '5',
    };
  });
}

function activeHealthTransaction() {
  return {
    select: () => ({
      from: () => ({
        where: async () => [
          {
            id: '00000000-0000-0000-0000-000000000001',
            builder_id: 'builder-a',
            source_type: 'llm_provider',
            display_name: 'openai',
            slug: 'openai',
            metric: null,
            last_seen_at: new Date(NOW.getTime() - 80 * 60 * 60 * 1000),
            status: 'healthy',
          },
        ],
      }),
    }),
    execute: mocks.statusExecute,
  };
}

function mockActiveHealthRun(deliveryOutcome: Record<string, unknown>): void {
  mocks.authorizeBuilderCapability.mockResolvedValue({
    allowed: true,
    lookup: { kind: 'resolved' },
  });
  mocks.withRLS.mockImplementation(
    async (
      _builderId: string,
      callback: (tx: ReturnType<typeof activeHealthTransaction>) => Promise<unknown>,
    ) => callback(activeHealthTransaction()),
  );
  mocks.queryCostEvents.mockResolvedValue(denseAggregateRows());
  mocks.statusExecute.mockResolvedValue([]);
  mocks.deliverBuilderAlert.mockResolvedValue(deliveryOutcome);
}

describe('health worker workspace lifecycle gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbExecute.mockResolvedValue([{ builder_id: 'builder-a' }]);
    mocks.getBuilderEntitlementForShare.mockResolvedValue({
      ok: true,
      entitlement: {
        plan: 'pro',
        access_state: 'active',
        entitlement_source: 'stripe',
        has_product_access: true,
        legacy_free: false,
      },
    });
  });

  it('does no tenant or ClickHouse work without product access', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValue({
      allowed: false,
      lookup: { kind: 'resolved' },
    });

    await expect(runHealthCheck()).resolves.toMatchObject({
      scanned_builders: 1,
      scanned_sources: 0,
      errors: 0,
    });
    expect(mocks.authorizeBuilderCapability).toHaveBeenCalledWith('builder-a', 'product');
    expect(mocks.withRLS).not.toHaveBeenCalled();
    expect(mocks.queryCostEvents).not.toHaveBeenCalled();
  });

  it('reports entitlement lookup outages as worker failures', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValue({
      allowed: false,
      lookup: { kind: 'lookup_failed' },
    });

    await expect(runHealthCheck()).resolves.toMatchObject({
      scanned_builders: 1,
      errors: 1,
    });
    expect(mocks.withRLS).not.toHaveBeenCalled();
    expect(mocks.queryCostEvents).not.toHaveBeenCalled();
  });

  it.each([
    ['delivered', { kind: 'delivered' }, 1],
    ['access denied', { kind: 'access_denied' }, 0],
    ['skipped', { kind: 'skipped', reason: 'no_config' }, 0],
    ['failed', { kind: 'failed', error: 'channel down' }, 0],
  ] as const)(
    'counts only successfully delivered alerts when delivery is %s',
    async (_label, outcome, expectedAlerts) => {
      mockActiveHealthRun(outcome);

      await expect(runHealthCheck({ now: NOW })).resolves.toMatchObject({
        scanned_builders: 1,
        silence_alerts: expectedAlerts,
        cost_drop_alerts: 0,
        errors: 0,
      });
      expect(mocks.deliverBuilderAlert).toHaveBeenCalledTimes(1);
    },
  );

  it('does not update source status or deliver after suspension lands during aggregate loading', async () => {
    let resumeAggregates!: () => void;
    let signalAggregatesStarted!: () => void;
    const aggregatesStarted = new Promise<void>((resolve) => {
      signalAggregatesStarted = resolve;
    });
    const pausedAggregates = new Promise<void>((resolve) => {
      resumeAggregates = resolve;
    });
    let hasProductAccess = true;

    mocks.authorizeBuilderCapability.mockImplementation(async () => ({
      allowed: hasProductAccess,
      lookup: { kind: 'resolved' },
    }));
    mocks.withRLS.mockImplementation(
      async (
        _builderId: string,
        callback: (tx: {
          select: () => {
            from: () => {
              where: () => Promise<
                Array<{
                  id: string;
                  builder_id: string;
                  source_type: string;
                  display_name: string;
                  slug: string;
                  metric: null;
                  last_seen_at: Date;
                  status: string;
                }>
              >;
            };
          };
          execute: typeof mocks.statusExecute;
        }) => Promise<unknown>,
      ) =>
        callback({
          select: () => ({
            from: () => ({
              where: async () => [
                {
                  id: '00000000-0000-0000-0000-000000000001',
                  builder_id: 'builder-a',
                  source_type: 'llm_provider',
                  display_name: 'openai',
                  slug: 'openai',
                  metric: null,
                  last_seen_at: new Date(NOW.getTime() - 80 * 60 * 60 * 1000),
                  status: 'healthy',
                },
              ],
            }),
          }),
          execute: mocks.statusExecute,
        }),
    );
    mocks.queryCostEvents.mockImplementationOnce(async () => {
      signalAggregatesStarted();
      await pausedAggregates;
      return denseAggregateRows();
    });
    mocks.deliverBuilderAlert.mockResolvedValue({ kind: 'delivered' });

    const run = runHealthCheck({ now: NOW });
    await aggregatesStarted;
    hasProductAccess = false;
    resumeAggregates();

    await expect(run).resolves.toMatchObject({
      scanned_builders: 1,
      errors: 0,
    });
    expect(mocks.statusExecute).not.toHaveBeenCalled();
    expect(mocks.deliverBuilderAlert).not.toHaveBeenCalled();
  });

  it('revalidates the lifecycle row inside the status update transaction', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValue({
      allowed: true,
      lookup: { kind: 'resolved' },
    });
    mocks.withRLS.mockImplementation(
      async (
        _builderId: string,
        callback: (tx: {
          select: () => {
            from: () => {
              where: () => Promise<
                Array<{
                  id: string;
                  builder_id: string;
                  source_type: string;
                  display_name: string;
                  slug: string;
                  metric: null;
                  last_seen_at: Date;
                  status: string;
                }>
              >;
            };
          };
          execute: typeof mocks.statusExecute;
        }) => Promise<unknown>,
      ) =>
        callback({
          select: () => ({
            from: () => ({
              where: async () => [
                {
                  id: '00000000-0000-0000-0000-000000000001',
                  builder_id: 'builder-a',
                  source_type: 'llm_provider',
                  display_name: 'openai',
                  slug: 'openai',
                  metric: null,
                  last_seen_at: new Date(NOW.getTime() - 80 * 60 * 60 * 1000),
                  status: 'healthy',
                },
              ],
            }),
          }),
          execute: mocks.statusExecute,
        }),
    );
    mocks.queryCostEvents.mockResolvedValue(denseAggregateRows());
    mocks.getBuilderEntitlementForShare.mockResolvedValue({
      ok: true,
      entitlement: {
        plan: null,
        access_state: 'suspended',
        entitlement_source: 'stripe',
        has_product_access: false,
        legacy_free: false,
      },
    });

    await expect(runHealthCheck({ now: NOW })).resolves.toMatchObject({
      scanned_builders: 1,
      silence_alerts: 0,
      status_changes: 0,
      errors: 0,
    });
    expect(mocks.getBuilderEntitlementForShare).toHaveBeenCalledWith(
      expect.anything(),
      'builder-a',
    );
    expect(mocks.statusExecute).not.toHaveBeenCalled();
    expect(mocks.deliverBuilderAlert).not.toHaveBeenCalled();
  });
});
