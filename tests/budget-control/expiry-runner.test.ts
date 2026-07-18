import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  budgetQuery: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/lib/budget-control/runtime-posture.js', () => ({
  getReadyBudgetControlSql: vi.fn(
    async () =>
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        mocks.budgetQuery(strings.join('?').replace(/\s+/g, ' ').trim(), values),
  ),
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ error: mocks.error, info: mocks.info, warn: mocks.warn }) },
}));
vi.mock('../../src/lib/budget-control/lifecycle-service.js', () => ({
  expireDueBudgetReservations: vi.fn(),
}));

const { runBudgetReservationExpiry, __budgetReservationExpiryTesting } =
  await import('../../src/lib/budget-control/expiry-runner.js');

function onePage(builderIds: string[]) {
  return vi.fn(async (afterBuilderId: string | null) =>
    afterBuilderId === null ? builderIds : [],
  );
}

describe('authoritative budget reservation expiry runner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a no-op when there are no builders', async () => {
    const expireForBuilder = vi.fn();
    const listBuilderPage = onePage([]);
    await expect(
      runBudgetReservationExpiry({}, { listBuilderPage, expireForBuilder }),
    ).resolves.toEqual({ scanned_builders: 0, expired_reservations: 0, errors: 0 });
    expect(listBuilderPage).toHaveBeenCalledWith(null, 250);
    expect(expireForBuilder).not.toHaveBeenCalled();
  });

  it('aggregates expirations and forwards the bounded per-builder limit', async () => {
    const expireForBuilder = vi
      .fn<(builderId: string, limit: number) => Promise<{ expired: number }>>()
      .mockImplementation(async (builderId, limit) => ({
        expired: builderId === 'builder-a' ? limit : 2,
      }));

    await expect(
      runBudgetReservationExpiry(
        { perBuilderLimit: 7 },
        { listBuilderPage: onePage(['builder-a', 'builder-b']), expireForBuilder },
      ),
    ).resolves.toEqual({ scanned_builders: 2, expired_reservations: 9, errors: 0 });
    expect(expireForBuilder.mock.calls).toEqual([
      ['builder-a', 7],
      ['builder-b', 7],
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      {
        builder_ref: __budgetReservationExpiryTesting.builderLogReference('builder-a'),
        expired: 7,
        per_builder_limit: 7,
      },
      'budget reservation expiry reached the per-builder batch limit',
    );
  });

  it('walks tenant identities in bounded keyset pages without retaining the full list', async () => {
    const listBuilderPage = vi.fn(async (afterBuilderId: string | null, limit: number) => {
      expect(limit).toBe(2);
      if (afterBuilderId === null) return ['builder-a', 'builder-b'];
      if (afterBuilderId === 'builder-b') return ['builder-c', 'builder-d'];
      if (afterBuilderId === 'builder-d') return ['builder-e'];
      throw new Error(`unexpected cursor ${afterBuilderId}`);
    });
    const expireForBuilder = vi.fn(async () => ({ expired: 1 }));

    await expect(
      runBudgetReservationExpiry(
        {},
        { listBuilderPage, expireForBuilder, builderPageSize: 2, builderConcurrency: 2 },
      ),
    ).resolves.toEqual({ scanned_builders: 5, expired_reservations: 5, errors: 0 });
    expect(listBuilderPage.mock.calls).toEqual([
      [null, 2],
      ['builder-b', 2],
      ['builder-d', 2],
    ]);
  });

  it('uses the bounded 052 due-reservation discovery function when no test loader is supplied', async () => {
    mocks.budgetQuery
      .mockResolvedValueOnce([
        { builder_id_text: '00000000-0000-4000-8000-000000000001' },
        { builder_id_text: '00000000-0000-4000-8000-000000000002' },
      ])
      .mockResolvedValueOnce([]);
    const expireForBuilder = vi.fn(async () => ({ expired: 0 }));

    await expect(
      runBudgetReservationExpiry({}, { expireForBuilder, builderPageSize: 2 }),
    ).resolves.toEqual({ scanned_builders: 2, expired_reservations: 0, errors: 0 });
    expect(mocks.budgetQuery).toHaveBeenCalledTimes(2);
    expect(mocks.budgetQuery.mock.calls[0]?.[0]).toContain(
      'public.pylva_budget_expiry_actionable_builders',
    );
    expect(mocks.budgetQuery.mock.calls[0]?.[0]).not.toContain('FROM public.builders');
    expect(expireForBuilder).toHaveBeenCalledTimes(2);
  });

  it('fails closed when expiry discovery returns a malformed identity', async () => {
    mocks.budgetQuery.mockResolvedValueOnce([{ builder_id_text: 'not-a-uuid' }]);
    await expect(runBudgetReservationExpiry({}, { expireForBuilder: vi.fn() })).rejects.toThrow(
      'invalid builder identity',
    );
  });

  it('isolates one tenant failure without stopping other builders', async () => {
    const expireForBuilder = vi.fn(async (builderId: string) => {
      if (builderId === 'builder-b') throw new Error('tenant database secret must not be logged');
      return { expired: 1 };
    });

    await expect(
      runBudgetReservationExpiry(
        {},
        {
          listBuilderPage: onePage(['builder-a', 'builder-b', 'builder-c']),
          expireForBuilder,
        },
      ),
    ).resolves.toEqual({ scanned_builders: 3, expired_reservations: 2, errors: 1 });
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const metadata = mocks.error.mock.calls[0]?.[0];
    expect(metadata).toEqual({
      builder_ref: __budgetReservationExpiryTesting.builderLogReference('builder-b'),
      error_type: 'Error',
    });
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('builder-b');
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('database secret');
  });

  it('never exceeds configured builder concurrency', async () => {
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const expireForBuilder = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return { expired: 0 };
    });

    const run = runBudgetReservationExpiry(
      {},
      {
        listBuilderPage: onePage(['a', 'b', 'c', 'd']),
        expireForBuilder,
        builderConcurrency: 2,
      },
    );
    await vi.waitFor(() => expect(expireForBuilder).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    release?.();
    await expect(run).resolves.toEqual({
      scanned_builders: 4,
      expired_reservations: 0,
      errors: 0,
    });
    expect(maximumActive).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101])(
    'rejects unsafe per-builder limit %s before scanning',
    async (perBuilderLimit) => {
      const listBuilderPage = onePage(['builder-a']);
      await expect(
        runBudgetReservationExpiry({ perBuilderLimit }, { listBuilderPage }),
      ).rejects.toThrow('perBuilderLimit must be an integer between 1 and 100');
      expect(listBuilderPage).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 26])(
    'rejects unsafe builder concurrency %s before scanning',
    async (builderConcurrency) => {
      const listBuilderPage = onePage(['builder-a']);
      await expect(
        runBudgetReservationExpiry({}, { listBuilderPage, builderConcurrency }),
      ).rejects.toThrow('builderConcurrency must be an integer between 1 and 25');
      expect(listBuilderPage).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_001])(
    'rejects unsafe builder page size %s before scanning',
    async (builderPageSize) => {
      const listBuilderPage = onePage(['builder-a']);
      await expect(
        runBudgetReservationExpiry({}, { listBuilderPage, builderPageSize }),
      ).rejects.toThrow('builderPageSize must be an integer between 1 and 1000');
      expect(listBuilderPage).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['too many identities', ['a', 'b', 'c'], null],
    ['cursor replay', ['b'], 'b'],
    ['out-of-order identities', ['b', 'a'], null],
    ['empty identity', [''], null],
  ] as const)('rejects a malformed builder page: %s', (_name, page, cursor) => {
    expect(() =>
      __budgetReservationExpiryTesting.validateBuilderPage([...page], cursor, 2),
    ).toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101])(
    'isolates an invalid service count %s as a builder failure',
    async (expired) => {
      await expect(
        runBudgetReservationExpiry(
          {},
          {
            listBuilderPage: onePage(['builder-a']),
            expireForBuilder: async () => ({ expired }),
          },
        ),
      ).resolves.toEqual({ scanned_builders: 1, expired_reservations: 0, errors: 1 });
    },
  );

  it('publishes stable bounded operational defaults', () => {
    expect(__budgetReservationExpiryTesting).toMatchObject({
      defaultBuilderConcurrency: 5,
      maxBuilderConcurrency: 25,
      defaultBuilderPageSize: 250,
      maxBuilderPageSize: 1_000,
      defaultPerBuilderLimit: 100,
      maxPerBuilderLimit: 100,
    });
  });
});
