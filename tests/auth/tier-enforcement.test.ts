import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderTier } from '@pylva/shared';
import { sqlText } from '../_helpers/drizzle-mock.js';
import type { TierFeature } from '../../src/lib/auth/tier-enforcement.js';

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

const { TIER_FEATURES, checkCustomerLimit, checkFeatureGate, getBuilderTier, tierUsageHeader } =
  await import('../../src/lib/auth/tier-enforcement.js');
const { getBuilderTierForShare, lockCustomerLimit } =
  await import('../../src/lib/db/advisory-locks.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.builderRows = [];
});

describe('checkFeatureGate', () => {
  it('allows every public self-host product feature on every tier', () => {
    const tiers = Object.values(BuilderTier);
    const features = Array.from(
      new Set(Object.values(TIER_FEATURES).flatMap((tierFeatures) => [...tierFeatures])),
    );

    for (const tier of tiers) {
      for (const feature of features) {
        expect(TIER_FEATURES[tier].has(feature), `${tier} should declare ${feature}`).toBe(true);
        expect(checkFeatureGate(tier, feature), `${tier} should include ${feature}`).toBeNull();
      }
    }
  });

  it('does not gate builder-facing billing and portal features on Free', () => {
    for (const feature of [
      'billing',
      'webhooks',
      'portal',
      'white_label_portal',
      'advanced_rules',
      'simulator',
    ] as const satisfies readonly TierFeature[]) {
      expect(checkFeatureGate(BuilderTier.FREE, feature)).toBeNull();
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
    [BuilderTier.FREE, 10],
    [BuilderTier.PRO, 50],
    [BuilderTier.SCALE, 500],
    [BuilderTier.ENTERPRISE, 50_000],
  ] as const)('allows %s without a Pylva Cloud customer cap', async (tier, current) => {
    mockCustomerCount(current);

    await expect(checkCustomerLimit('builder-a', tier)).resolves.toMatchObject({
      allowed: true,
      current,
      limit: Infinity,
    });
  });

  it('formats unlimited usage headers', () => {
    expect(tierUsageHeader(50_000, Infinity)).toBe('50000/unlimited');
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

describe('getBuilderTierForShare', () => {
  it('reads the builder tier with a FOR SHARE row lock', async () => {
    const execute = vi.fn().mockResolvedValue([{ tier: BuilderTier.PRO }]);
    const tx = { execute } as unknown as Parameters<typeof getBuilderTierForShare>[0];

    await expect(getBuilderTierForShare(tx, 'builder-a')).resolves.toBe(BuilderTier.PRO);

    expect(execute).toHaveBeenCalledTimes(1);
    const query = sqlText(execute.mock.calls[0]?.[0]);
    expect(query).toContain('SELECT tier');
    expect(query).toContain('FROM builders');
    expect(query).toContain('builder-a');
    expect(query).toContain('FOR SHARE');
  });

  it('returns null for a missing builder or unknown tier string', async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ tier: 'legacy_custom' }]),
    } as unknown as Parameters<typeof getBuilderTierForShare>[0];

    await expect(getBuilderTierForShare(tx, 'missing-builder')).resolves.toBeNull();
    await expect(getBuilderTierForShare(tx, 'builder-a')).resolves.toBeNull();
  });
});

describe('getBuilderTier', () => {
  it('returns the tier when the builder exists', async () => {
    mocks.builderRows = [{ tier: BuilderTier.PRO }];

    await expect(getBuilderTier('builder-a')).resolves.toBe(BuilderTier.PRO);
  });

  it('returns null when the builder does not exist', async () => {
    mocks.builderRows = [];

    await expect(getBuilderTier('missing-builder')).resolves.toBeNull();
  });
});
