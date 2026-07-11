import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode, RuleStatus, RuleType } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  getRule: vi.fn(),
  isFeatureEnabled: vi.fn(),
  previewRule: vi.fn(),
  promoteRuleStatus: vi.fn(),
  snapshotBackupPrice: vi.fn(),
  updateRule: vi.fn(),
  withRLS: vi.fn(async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({ tx: true }),
  ),
}));

vi.mock('../../src/lib/auth/middleware.js', () => ({
  Role: { OWNER: 'owner', MEMBER: 'member' },
  withRole: (allowed: string[], role: string | null) =>
    role && allowed.includes(role)
      ? null
      : Response.json(
          {
            error: {
              type: 'invalid_request_error',
              code: ErrorCode.INSUFFICIENT_PERMISSIONS,
              message: `Only ${allowed.join(', ')} can perform this action`,
            },
          },
          { status: 403 },
        ),
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({ auditLog: mocks.auditLog }));
vi.mock('../../src/lib/db/rls.js', () => ({ withRLS: mocks.withRLS }));
vi.mock('../../src/lib/feature-flags.js', () => ({ isFeatureEnabled: mocks.isFeatureEnabled }));
vi.mock('../../src/lib/rules/backup-price-snapshot.js', () => ({
  snapshotBackupPrice: mocks.snapshotBackupPrice,
}));
vi.mock('../../src/lib/rules/preview.js', () => ({ previewRule: mocks.previewRule }));
vi.mock('../../src/lib/rules/repository.js', () => ({
  getRule: mocks.getRule,
  promoteRuleStatus: mocks.promoteRuleStatus,
  updateRule: mocks.updateRule,
}));
vi.mock('../../src/lib/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ tier: 'pro' }]),
        }),
      }),
    }),
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

const activateRoute = await import('../../src/app/api/v1/rules/[id]/activate/route.js');
const previewRoute = await import('../../src/app/api/v1/rules/[id]/preview/route.js');

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';

function dashboardRequest(
  body: Record<string, unknown> = {},
  role: 'owner' | 'member' = 'owner',
): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/rule-1/activate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-builder-id': BUILDER_ID,
      'x-user-id': 'user-1',
      'x-user-role': role,
    },
    body: JSON.stringify(body),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    builder_id: BUILDER_ID,
    type: RuleType.COST_THRESHOLD,
    name: 'Cost threshold',
    enabled: true,
    status: RuleStatus.DRAFT,
    config: { threshold_usd: 25, period: 'day', scope: 'per_customer' },
    ...overrides,
  };
}

const params = { params: Promise.resolve({ id: 'rule-1' }) };

describe('POST /api/v1/rules/[id]/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isFeatureEnabled.mockResolvedValue(true);
    mocks.previewRule.mockResolvedValue({
      affected_customers: [{ customer_id: 'cust_1' }],
      total_customers: 4,
      live_traffic_warning: false,
      warnings: [],
    });
    mocks.getRule.mockResolvedValue(ruleRow());
    mocks.promoteRuleStatus.mockResolvedValue(ruleRow({ status: RuleStatus.ACTIVE }));
  });

  it('is owner-only', async () => {
    const response = await activateRoute.POST(
      dashboardRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Cost threshold' }, 'member'),
      params,
    );

    expect(response.status).toBe(403);
    expect(mocks.getRule).not.toHaveBeenCalled();
  });

  it('promotes a draft rule to active and returns impact metadata', async () => {
    const response = await activateRoute.POST(
      dashboardRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Cost threshold' }),
      params,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rule: { id: 'rule-1', status: RuleStatus.ACTIVE },
      no_op: false,
      impact_pct: 25,
      high_impact_warning: false,
    });
    expect(mocks.promoteRuleStatus).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', RuleStatus.ACTIVE);
  });

  it('pins already-active activation as a 200 no-op', async () => {
    mocks.getRule.mockResolvedValueOnce(ruleRow({ status: RuleStatus.ACTIVE }));

    const response = await activateRoute.POST(
      dashboardRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Cost threshold' }),
      params,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rule: { id: 'rule-1', status: RuleStatus.ACTIVE },
      preview: null,
      no_op: true,
    });
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/rules/[id]/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRule.mockResolvedValue(ruleRow());
    mocks.previewRule.mockResolvedValue({
      affected_customers: [{ customer_id: 'cust_1' }],
      description: 'Would affect cust_1',
      live_traffic_warning: false,
      warnings: [],
    });
  });

  it('returns the impact estimate for an owned rule', async () => {
    const response = await previewRoute.POST(dashboardRequest(), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      preview: {
        affected_customers: [{ customer_id: 'cust_1' }],
        description: 'Would affect cust_1',
      },
    });
    expect(mocks.getRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1');
  });

  it('returns 404 for nonexistent or cross-tenant rule ids', async () => {
    mocks.getRule.mockResolvedValueOnce(null);

    const response = await previewRoute.POST(dashboardRequest(), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.NOT_FOUND },
    });
    expect(mocks.previewRule).not.toHaveBeenCalled();
  });
});
