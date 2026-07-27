import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BuilderEntitlementErrorReason,
  BuilderPlan,
  PLAN_LIMITS,
  resolveBuilderEntitlement,
} from '@pylva/shared';
import type { WorkspaceCapability } from '../../src/lib/auth/builder-entitlement.js';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{
    plan: unknown;
    access_state: unknown;
    entitlement_source: unknown;
  }>,
  dbError: null as Error | null,
  error: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));
vi.mock('../../src/lib/db/schema.js', () => ({
  builders: {
    id: 'builders.id',
    tier: 'builders.tier',
    access_state: 'builders.access_state',
    entitlement_source: 'builders.entitlement_source',
  },
}));
vi.mock('../../src/lib/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (mocks.dbError) throw mocks.dbError;
            return mocks.rows;
          },
        }),
      }),
    }),
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ error: mocks.error }) },
}));

const {
  authorizeBuilderCapability,
  entitlementAllowsCapability,
  loadBuilderEntitlement,
} =
  await import('../../src/lib/auth/builder-entitlement.js');

const capabilities: WorkspaceCapability[] = [
  'product',
  'account_recovery',
  'platform_billing',
  'invoices',
  'export',
];

function allowed(input: {
  plan: unknown;
  access_state: unknown;
  entitlement_source: unknown;
}): WorkspaceCapability[] {
  const resolution = resolveBuilderEntitlement(input);
  return capabilities.filter((capability) =>
    entitlementAllowsCapability(resolution, capability),
  );
}

describe('workspace entitlement capability matrix', () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.dbError = null;
    mocks.error.mockReset();
  });

  it.each([
    ['pro', 'stripe'],
    ['pro', 'admin'],
    ['scale', 'stripe'],
    ['scale', 'admin'],
    ['enterprise', 'enterprise_contract'],
    ['enterprise', 'admin'],
  ])('grants every capability to active %s/%s', (plan, source) => {
    expect(
      allowed({ plan, access_state: 'active', entitlement_source: source }),
    ).toEqual(capabilities);
  });

  it('grants every capability to active planless self-hosted workspaces', () => {
    expect(
      allowed({
        plan: null,
        access_state: 'active',
        entitlement_source: 'self_hosted',
      }),
    ).toEqual(capabilities);
  });

  it('limits checkout-required workspaces to account recovery and platform billing', () => {
    expect(
      allowed({
        plan: null,
        access_state: 'checkout_required',
        entitlement_source: null,
      }),
    ).toEqual(['account_recovery', 'platform_billing']);
  });

  it.each([null, 'stripe', 'admin'])(
    'limits suspended/%s workspaces to recovery, billing, and export',
    (source) => {
      expect(
        allowed({
          plan: null,
          access_state: 'suspended',
          entitlement_source: source,
        }),
      ).toEqual(['account_recovery', 'platform_billing', 'invoices', 'export']);
    },
  );

  it('treats the sole legacy Free compatibility tuple as checkout-required', () => {
    expect(
      allowed({
        plan: 'free',
        access_state: null,
        entitlement_source: null,
      }),
    ).toEqual(['account_recovery', 'platform_billing']);
  });

  it.each([
    { plan: 'mystery', access_state: 'active', entitlement_source: 'stripe' },
    { plan: 'pro', access_state: 'suspended', entitlement_source: 'stripe' },
    { plan: null, access_state: 'active', entitlement_source: null },
    { plan: null, access_state: 'unknown', entitlement_source: null },
    { plan: null, access_state: 'active', entitlement_source: 'unknown' },
  ])('fails closed for invalid tuple %#', (tuple) => {
    expect(allowed(tuple)).toEqual([]);
  });

  it('logs the invalid reason directly and denies a persisted malformed tuple', async () => {
    mocks.rows = [
      {
        plan: 'mystery',
        access_state: 'active',
        entitlement_source: 'stripe',
      },
    ];

    await expect(authorizeBuilderCapability('builder-invalid', 'product')).resolves.toMatchObject({
      allowed: false,
      lookup: {
        kind: 'resolved',
        resolution: {
          ok: false,
          reason: BuilderEntitlementErrorReason.UNKNOWN_PLAN,
        },
      },
    });
    expect(mocks.error).toHaveBeenCalledWith(
      {
        builder_id: 'builder-invalid',
        reason: BuilderEntitlementErrorReason.UNKNOWN_PLAN,
      },
      'invalid builder entitlement; access denied',
    );
  });

  it('denies and logs when a known paid plan has no limit mapping', async () => {
    mocks.rows = [
      {
        plan: BuilderPlan.PRO,
        access_state: 'active',
        entitlement_source: 'stripe',
      },
    ];
    const mutableLimits = PLAN_LIMITS as Partial<typeof PLAN_LIMITS>;
    const originalCatalog = { ...PLAN_LIMITS };

    delete mutableLimits[BuilderPlan.PRO];
    try {
      await expect(
        authorizeBuilderCapability('builder-missing-limits', 'product'),
      ).resolves.toMatchObject({
        allowed: false,
        lookup: {
          kind: 'resolved',
          resolution: {
            ok: false,
            reason: BuilderEntitlementErrorReason.MISSING_PLAN_LIMITS,
          },
        },
      });
    } finally {
      for (const key of Object.keys(mutableLimits) as BuilderPlan[]) delete mutableLimits[key];
      Object.assign(mutableLimits, originalCatalog);
    }

    expect(mocks.error).toHaveBeenCalledWith(
      {
        builder_id: 'builder-missing-limits',
        reason: BuilderEntitlementErrorReason.MISSING_PLAN_LIMITS,
      },
      'invalid builder entitlement; access denied',
    );
  });

  it('logs a bounded database error type and returns lookup_failed', async () => {
    mocks.dbError = new TypeError('sensitive database detail');

    await expect(loadBuilderEntitlement('builder-db-failure')).resolves.toEqual({
      kind: 'lookup_failed',
    });
    expect(mocks.error).toHaveBeenCalledWith(
      {
        builder_id: 'builder-db-failure',
        error_type: 'TypeError',
      },
      'builder entitlement lookup failed; access denied',
    );
  });

  it('returns not_found without emitting a configuration error', async () => {
    await expect(loadBuilderEntitlement('builder-missing')).resolves.toEqual({
      kind: 'not_found',
    });
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
