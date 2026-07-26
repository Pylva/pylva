import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderPlan } from '@pylva/shared';
import { sqlText } from '../_helpers/drizzle-mock.js';
import type { PlanFeature } from '../../src/lib/auth/tier-enforcement.js';

const mocks = vi.hoisted(() => ({
  builderRows: [] as Array<{ tier: string }>,
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mocks.builderRows),
        }),
      }),
    }),
  },
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  accessDeniedMessage: vi.fn(() => 'Workspace access is unavailable'),
  authorizeBuilderCapability: vi.fn(),
}));

const {
  PLAN_FEATURES,
  checkCustomerLimit,
  checkCustomerLimitAgainstLimitInTransaction,
  checkFeatureGate,
  getBuilderPlan,
  tierUsageHeader,
} = await import('../../src/lib/auth/tier-enforcement.js');
const {
  builderBillingLifecycleLockKey,
  getBuilderEntitlementForShare,
  lockBuilderBillingLifecycle,
  lockCustomerLimit,
} = await import('../../src/lib/db/advisory-locks.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.builderRows = [];
});

describe('checkFeatureGate', () => {
  it('allows every public self-host product feature on every tier', () => {
    const tiers = Object.values(BuilderPlan);
    const features = Array.from(
      new Set(Object.values(PLAN_FEATURES).flatMap((planFeatures) => [...planFeatures])),
    );

    for (const tier of tiers) {
      for (const feature of features) {
        expect(PLAN_FEATURES[tier].has(feature), `${tier} should declare ${feature}`).toBe(true);
        expect(checkFeatureGate(tier, feature), `${tier} should include ${feature}`).toBeNull();
      }
    }
  });

  it('does not gate self-host builder-facing features by commercial plan', () => {
    for (const feature of [
      'billing',
      'webhooks',
      'portal',
      'white_label_portal',
      'advanced_rules',
      'simulator',
    ] as const satisfies readonly PlanFeature[]) {
      expect(checkFeatureGate(BuilderPlan.PRO, feature)).toBeNull();
    }
  });
});

describe('checkCustomerLimit', () => {
  function mockCustomerCount(current: number): void {
    mocks.withRLS.mockImplementationOnce(
      async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([{ count: current }]),
            }),
          }),
        }),
    );
  }

  it.each([
    [null, 10],
    [BuilderPlan.PRO, 50],
    [BuilderPlan.SCALE, 500],
    [BuilderPlan.ENTERPRISE, 50_000],
  ] as const)('allows %s without a Pylva Cloud customer cap', async (plan, current) => {
    mockCustomerCount(current);

    await expect(checkCustomerLimit('builder-a', plan)).resolves.toMatchObject({
      allowed: true,
      current,
      limit: Infinity,
    });
  });

  it('formats unlimited usage headers', () => {
    expect(tierUsageHeader(50_000, Infinity)).toBe('50000/unlimited');
  });

  it.each([
    [499, true],
    [500, false],
    [501, false],
  ] as const)('enforces an explicit finite deployment limit at %i customers', async (current, allowed) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ count: current }]),
        }),
      }),
    } as unknown as Parameters<typeof checkCustomerLimitAgainstLimitInTransaction>[0];

    const result = await checkCustomerLimitAgainstLimitInTransaction(
      tx,
      'builder-a',
      500,
    );

    expect(result).toMatchObject({ allowed, current, limit: 500 });
    expect(result.response?.status ?? null).toBe(allowed ? null : 403);
  });
});

describe('lockCustomerLimit', () => {
  it('takes a transaction-scoped advisory lock for the builder customer limit', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const tx = { execute } as unknown as Parameters<typeof lockCustomerLimit>[0];

    await lockCustomerLimit(tx, 'builder-a');

    expect(execute).toHaveBeenCalledTimes(1);
    const query = sqlText(execute.mock.calls[0]?.[0]);
    expect(query).toContain('pg_advisory_xact_lock');
    expect(query).toContain('hashtextextended');
    expect(query).toContain('customer_limit:builder-a');
  });
});

describe('lockBuilderBillingLifecycle', () => {
  it('preserves the raw builder-id key shared with mixed-version billing writers', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const tx = { execute } as unknown as Parameters<typeof lockBuilderBillingLifecycle>[0];

    expect(builderBillingLifecycleLockKey('builder-a')).toBe('builder-a');
    await lockBuilderBillingLifecycle(tx, 'builder-a');

    expect(execute).toHaveBeenCalledTimes(1);
    const query = sqlText(execute.mock.calls[0]?.[0]);
    expect(query).toContain('pg_advisory_xact_lock');
    expect(query).toContain('hashtextextended');
    expect(query).toContain('builder-a');
    expect(query).not.toContain('customer_limit:builder-a');
  });
});

describe('getBuilderEntitlementForShare', () => {
  it('reads and resolves the complete entitlement with a FOR SHARE row lock', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        plan: BuilderPlan.PRO,
        access_state: 'active',
        entitlement_source: 'admin',
      },
    ]);
    const tx = {
      execute,
    } as unknown as Parameters<typeof getBuilderEntitlementForShare>[0];

    await expect(getBuilderEntitlementForShare(tx, 'builder-a')).resolves.toMatchObject({
      ok: true,
      entitlement: {
        plan: BuilderPlan.PRO,
        access_state: 'active',
        entitlement_source: 'admin',
        has_product_access: true,
      },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const query = sqlText(execute.mock.calls[0]?.[0]);
    expect(query).toContain('tier');
    expect(query).toContain('access_state');
    expect(query).toContain('entitlement_source');
    expect(query).toContain('FROM builders');
    expect(query).toContain('builder-a');
    expect(query).toContain('FOR SHARE');
  });

  it('distinguishes a missing builder from an invalid entitlement tuple', async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            plan: 'legacy_custom',
            access_state: 'active',
            entitlement_source: 'admin',
          },
        ]),
    } as unknown as Parameters<typeof getBuilderEntitlementForShare>[0];

    await expect(getBuilderEntitlementForShare(tx, 'missing-builder')).resolves.toBeNull();
    await expect(getBuilderEntitlementForShare(tx, 'builder-a')).resolves.toEqual({
      ok: false,
      reason: 'unknown_plan',
    });
  });
});

describe('getBuilderPlan', () => {
  it('returns the plan when the builder exists', async () => {
    mocks.builderRows = [{ tier: BuilderPlan.PRO }];

    await expect(getBuilderPlan('builder-a')).resolves.toBe(BuilderPlan.PRO);
  });

  it('returns null when the builder does not exist', async () => {
    mocks.builderRows = [];

    await expect(getBuilderPlan('missing-builder')).resolves.toBeNull();
  });
});
