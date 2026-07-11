import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  readBuilderContextFromDashboard: vi.fn(),
  withRLS: vi.fn(),
  getCustomerCostSummary: vi.fn(),
  getBuilderTierForShare: vi.fn(),
  checkCustomerLimitInTransaction: vi.fn(),
  lockCustomerLimit: vi.fn(),
  tierUsageHeader: vi.fn(),
  txSelect: vi.fn(),
  txInsert: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: mocks.readBuilderContextFromDashboard,
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkCustomerLimitInTransaction: mocks.checkCustomerLimitInTransaction,
  tierUsageHeader: mocks.tierUsageHeader,
}));

vi.mock('@/lib/db/advisory-locks', () => ({
  getBuilderTierForShare: mocks.getBuilderTierForShare,
  lockCustomerLimit: mocks.lockCustomerLimit,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/clickhouse/dashboard-queries', () => ({
  getCustomerCostSummary: mocks.getCustomerCostSummary,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: () => undefined, error: () => undefined }),
  },
}));

const { POST } = await import('../src/app/api/v1/customers/route.js');

function makePost(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v1/customers', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/v1/customers contact upsert', () => {
  let insertValues: Record<string, unknown> | null;
  let conflictSet: Record<string, unknown> | null;
  let existingRows: Array<{ id: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    insertValues = null;
    conflictSet = null;
    existingRows = [];
    mocks.readBuilderContextFromDashboard.mockReturnValue({
      builderId: BUILDER_ID,
      userId: 'user-1',
      role: 'owner',
    });
    mocks.getBuilderTierForShare.mockResolvedValue('free');
    mocks.lockCustomerLimit.mockResolvedValue(undefined);
    mocks.checkCustomerLimitInTransaction.mockResolvedValue({
      allowed: true,
      current: 0,
      limit: 10,
    });
    mocks.tierUsageHeader.mockImplementation(
      (current: number, limit: number) => `${current}/${limit}`,
    );
    mocks.withRLS.mockImplementation(async (_builderId: string, cb: (tx: unknown) => unknown) => {
      const tx = {
        select: mocks.txSelect,
        insert: mocks.txInsert,
      };
      return cb(tx);
    });
    mocks.txSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existingRows),
        }),
      }),
    }));
    mocks.txInsert.mockImplementation(() => ({
      values: (values: Record<string, unknown>) => {
        insertValues = values;
        return {
          onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => {
            conflictSet = opts.set;
            return {
              returning: () =>
                Promise.resolve([{ id: 'customer-row-1', external_id: values.external_id }]),
            };
          },
        };
      },
    }));
  });

  it('does not clear an existing email when a later upsert only changes the name', async () => {
    const response = await POST(
      makePost({
        external_id: 'lg_onboarding_audit_cust_1',
        name: 'Onboarding Audit Customer 1',
      }),
    );

    expect(response.status).toBe(200);
    expect(insertValues).toMatchObject({
      external_id: 'lg_onboarding_audit_cust_1',
      name: 'Onboarding Audit Customer 1',
      email: null,
    });
    expect(conflictSet).toMatchObject({ name: 'Onboarding Audit Customer 1' });
    expect(conflictSet).not.toHaveProperty('email');
    expect(response.headers.get('X-Pylva-Tier-Usage')).toBe('1/10');
  });

  it('does not clear an existing name when a later upsert only changes the email', async () => {
    const response = await POST(
      makePost({
        external_id: 'lg_onboarding_audit_cust_1',
        email: 'onboarding-cust-1@example.com',
      }),
    );

    expect(response.status).toBe(200);
    expect(insertValues).toMatchObject({
      external_id: 'lg_onboarding_audit_cust_1',
      name: null,
      email: 'onboarding-cust-1@example.com',
    });
    expect(conflictSet).toMatchObject({ email: 'onboarding-cust-1@example.com' });
    expect(conflictSet).not.toHaveProperty('name');
  });

  it('acquires the customer limit lock before checking the limit and inserting', async () => {
    const response = await POST(
      makePost({
        external_id: 'ordered_customer',
        name: 'Ordered Customer',
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.lockCustomerLimit).toHaveBeenCalledWith(expect.anything(), BUILDER_ID);
    expect(mocks.getBuilderTierForShare).toHaveBeenCalledWith(expect.anything(), BUILDER_ID);
    expect(mocks.checkCustomerLimitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      BUILDER_ID,
      'free',
    );

    const lockOrder = mocks.lockCustomerLimit.mock.invocationCallOrder[0];
    const tierOrder = mocks.getBuilderTierForShare.mock.invocationCallOrder[0];
    const selectOrder = mocks.txSelect.mock.invocationCallOrder[0];
    const limitOrder = mocks.checkCustomerLimitInTransaction.mock.invocationCallOrder[0];
    const insertOrder = mocks.txInsert.mock.invocationCallOrder[0];
    expect(lockOrder).toBeDefined();
    expect(tierOrder).toBeDefined();
    expect(selectOrder).toBeDefined();
    expect(limitOrder).toBeDefined();
    expect(insertOrder).toBeDefined();
    expect(lockOrder!).toBeLessThan(tierOrder!);
    expect(tierOrder!).toBeLessThan(selectOrder!);
    expect(selectOrder!).toBeLessThan(limitOrder!);
    expect(limitOrder!).toBeLessThan(insertOrder!);
  });

  it('uses the in-transaction tier for a new customer when the builder is at the limit', async () => {
    const forbidden = NextResponse.json(
      {
        error: {
          type: 'invalid_request_error',
          code: 'TIER_LIMIT_REACHED',
          message: 'free tier allows 10 customers. You have 10. Upgrade to add more.',
        },
      },
      { status: 403 },
    );
    mocks.getBuilderTierForShare.mockResolvedValueOnce('free');
    mocks.checkCustomerLimitInTransaction.mockResolvedValueOnce({
      allowed: false,
      current: 10,
      limit: 10,
      response: forbidden,
    });

    const response = await POST(
      makePost({
        external_id: 'blocked_customer',
        name: 'Blocked Customer',
      }),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('TIER_LIMIT_REACHED');
    expect(response.headers.get('X-Pylva-Tier-Usage')).toBe('10/10');
    expect(mocks.checkCustomerLimitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      BUILDER_ID,
      'free',
    );
    expect(mocks.lockCustomerLimit).toHaveBeenCalledWith(expect.anything(), BUILDER_ID);
    expect(mocks.txInsert).not.toHaveBeenCalled();
  });

  it('returns the missing-builder 404 when the in-transaction tier read finds no row', async () => {
    mocks.getBuilderTierForShare.mockResolvedValueOnce(null);

    const response = await POST(
      makePost({
        external_id: 'missing_builder_customer',
        name: 'Missing Builder Customer',
      }),
    );
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({
      code: ErrorCode.RESOURCE_NOT_FOUND,
      message: 'Builder not found',
    });
    expect(mocks.checkCustomerLimitInTransaction).not.toHaveBeenCalled();
    expect(mocks.txInsert).not.toHaveBeenCalled();
  });

  it('allows an existing customer upsert at the cap without incrementing usage', async () => {
    existingRows = [{ id: 'customer-row-1' }];
    const forbidden = NextResponse.json(
      {
        error: {
          type: 'invalid_request_error',
          code: 'TIER_LIMIT_REACHED',
          message: 'free tier allows 10 customers. You have 10. Upgrade to add more.',
        },
      },
      { status: 403 },
    );
    mocks.checkCustomerLimitInTransaction.mockResolvedValueOnce({
      allowed: false,
      current: 10,
      limit: 10,
      response: forbidden,
    });

    const response = await POST(
      makePost({
        external_id: 'existing_customer',
        name: 'Existing Customer',
      }),
    );
    const body = (await response.json()) as { customer: { external_id: string } };

    expect(response.status).toBe(200);
    expect(body.customer.external_id).toBe('existing_customer');
    expect(response.headers.get('X-Pylva-Tier-Usage')).toBe('10/10');
    expect(mocks.txInsert).toHaveBeenCalled();
  });

  it('returns current plus one usage for a new customer below the cap', async () => {
    mocks.checkCustomerLimitInTransaction.mockResolvedValueOnce({
      allowed: true,
      current: 9,
      limit: 10,
    });

    const response = await POST(
      makePost({
        external_id: 'last_allowed_customer',
        name: 'Last Allowed Customer',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Pylva-Tier-Usage')).toBe('10/10');
    expect(mocks.txInsert).toHaveBeenCalled();
  });
});

// F8 (B12): external_id must use the shared customerIdSchema charset.
// Telemetry ingest and rule targeting both validate against it, so a looser
// id here created customers that could never receive events or rules —
// and a ':' would collide with the composite "{builderId}:{external}"
// ClickHouse key.
describe('POST /api/v1/customers external_id charset (B12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readBuilderContextFromDashboard.mockReturnValue({
      builderId: BUILDER_ID,
      userId: 'user-1',
      role: 'owner',
    });
  });

  it.each([
    ['space', 'cust 1'],
    ['composite-id delimiter', 'builder:cust_1'],
    ['unicode', 'cust_✨'],
    ['slash', 'org/cust'],
    ['empty string', ''],
  ])('rejects external_id with %s', async (_label, externalId) => {
    const response = await POST(makePost({ external_id: externalId }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR },
    });
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });
});
