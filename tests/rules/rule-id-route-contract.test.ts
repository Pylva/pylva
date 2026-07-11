import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode, RuleStatus, RuleType } from '@pylva/shared';
import { POOLED_TARGETING_MESSAGE } from '../../src/lib/rules/validator.js';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  customerExternalIdExists: vi.fn(),
  deleteRule: vi.fn(),
  getRule: vi.fn(),
  toggleRule: vi.fn(),
  updateRule: vi.fn(),
  withRLS: vi.fn(async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({ tx: true }),
  ),
}));

vi.mock('@/lib/rules/repository', () => ({
  deleteRule: mocks.deleteRule,
  getRule: mocks.getRule,
  toggleRule: mocks.toggleRule,
  updateRule: mocks.updateRule,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/customers/lookup', () => ({
  customerExternalIdExists: mocks.customerExternalIdExists,
}));

vi.mock('@/lib/auth/middleware', () => ({
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

vi.mock('@/lib/db/client', () => ({
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

const route = await import('../../src/app/api/v1/rules/[id]/route.js');

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';

function request(body: Record<string, unknown>, role: 'owner' | 'member'): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/rule-1', {
    method: 'PATCH',
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
    status: RuleStatus.ACTIVE,
    config: { threshold_usd: 25, period: 'day', scope: 'per_customer' },
    ...overrides,
  };
}

describe('PATCH /api/v1/rules/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.customerExternalIdExists.mockResolvedValue(true);
    // Config/retarget patches validate the merged rule against the create
    // schema (B5), which needs the existing row.
    mocks.getRule.mockResolvedValue(ruleRow());
    mocks.toggleRule.mockResolvedValue(ruleRow({ enabled: false }));
    mocks.updateRule.mockResolvedValue(ruleRow({ name: 'Updated rule' }));
  });

  it.each(['member', 'owner'] as const)('allows %s to toggle enabled', async (role) => {
    const response = await route.PATCH(request({ enabled: false }, role), {
      params: Promise.resolve({ id: 'rule-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rule: { id: 'rule-1', enabled: false },
    });
    expect(mocks.toggleRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', false);
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it('keeps owner-only fields owner-only', async () => {
    const response = await route.PATCH(request({ name: 'member rename' }, 'member'), {
      params: Promise.resolve({ id: 'rule-1' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.updateRule).not.toHaveBeenCalled();
    expect(mocks.toggleRule).not.toHaveBeenCalled();
  });

  it('allows owners to retarget a rule to an existing selected end-user', async () => {
    mocks.updateRule.mockResolvedValueOnce(ruleRow({ customer_id: 'alice' }));

    const response = await route.PATCH(request({ customer_id: 'alice' }, 'owner'), {
      params: Promise.resolve({ id: 'rule-1' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.customerExternalIdExists).toHaveBeenCalledWith(BUILDER_ID, 'alice');
    expect(mocks.updateRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', {
      customer_id: 'alice',
    });
  });

  it('rejects retargeting a rule to an unknown end-user', async () => {
    mocks.customerExternalIdExists.mockResolvedValueOnce(false);

    const response = await route.PATCH(request({ customer_id: 'missing-user' }, 'owner'), {
      params: Promise.resolve({ id: 'rule-1' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        param: 'customer_id',
        message: 'Select an existing end-user for this rule.',
      },
    });
    expect(mocks.updateRule).not.toHaveBeenCalled();
    expect(mocks.toggleRule).not.toHaveBeenCalled();
  });

  it('returns 404 for a cross-tenant or nonexistent rule id on toggle', async () => {
    mocks.toggleRule.mockResolvedValueOnce(null);

    const response = await route.PATCH(request({ enabled: false }, 'member'), {
      params: Promise.resolve({ id: 'foreign-rule' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.NOT_FOUND },
    });
  });
});

// F5 (B5): PATCH validates the merged rule against the same per-type schema
// as create. Previously `config` was accepted as an arbitrary record, so a
// typo'd or wrong-shape payload silently produced a dead rule (empty budget
// config enforces nothing) or an overbroad one.
describe('PATCH /api/v1/rules/[id] config validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.customerExternalIdExists.mockResolvedValue(true);
    mocks.getRule.mockResolvedValue(ruleRow());
    mocks.updateRule.mockResolvedValue(ruleRow());
  });

  it('rejects a config whose shape belongs to a different rule type', async () => {
    // budget_limit-shaped config on a cost_threshold rule.
    const response = await route.PATCH(
      request(
        { config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'per_customer' } },
        'owner',
      ),
      { params: Promise.resolve({ id: 'rule-1' }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR },
    });
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it('rejects an empty config that would silently disable enforcement', async () => {
    const response = await route.PATCH(request({ config: {} }, 'owner'), {
      params: Promise.resolve({ id: 'rule-1' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it('accepts a valid config edit and persists the parsed config with schema defaults', async () => {
    const response = await route.PATCH(
      request({ config: { threshold_usd: 30, period: 'week' } }, 'owner'),
      { params: Promise.resolve({ id: 'rule-1' }) },
    );

    expect(response.status).toBe(200);
    // scope default stamped exactly like the create path.
    expect(mocks.updateRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', {
      config: { threshold_usd: 30, period: 'week', scope: 'per_customer' },
    });
  });

  it('rejects retargeting a pooled rule at a single end-user', async () => {
    mocks.getRule.mockResolvedValue(
      ruleRow({
        type: RuleType.BUDGET_LIMIT,
        config: { limit_usd: 20, period: 'day', hard_stop: true, scope: 'pooled' },
        customer_id: null,
      }),
    );

    const response = await route.PATCH(request({ customer_id: 'alice' }, 'owner'), {
      params: Promise.resolve({ id: 'rule-1' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: POOLED_TARGETING_MESSAGE },
    });
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it('keeps draft configs free-form (activation re-validates)', async () => {
    mocks.getRule.mockResolvedValue(ruleRow({ status: RuleStatus.DRAFT }));

    const response = await route.PATCH(
      request({ config: { anything: 'goes-for-drafts' } }, 'owner'),
      { params: Promise.resolve({ id: 'rule-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', {
      config: { anything: 'goes-for-drafts' },
    });
  });

  it('rejects steering a draft into the pooled+targeted contradiction', async () => {
    mocks.getRule.mockResolvedValue(
      ruleRow({
        status: RuleStatus.DRAFT,
        type: RuleType.BUDGET_LIMIT,
        config: { limit_usd: 20, period: 'day', hard_stop: true, scope: 'pooled' },
        customer_id: null,
      }),
    );

    const response = await route.PATCH(request({ customer_id: 'alice' }, 'owner'), {
      params: Promise.resolve({ id: 'rule-1' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: POOLED_TARGETING_MESSAGE },
    });
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it('returns 404 when the rule does not exist for a config patch', async () => {
    mocks.getRule.mockResolvedValue(null);

    const response = await route.PATCH(
      request({ config: { threshold_usd: 30, period: 'week' } }, 'owner'),
      { params: Promise.resolve({ id: 'rule-1' }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });
});
