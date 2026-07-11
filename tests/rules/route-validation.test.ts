import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode, RulePeriod, RuleScope, RuleStatus, RuleType } from '@pylva/shared';

const routeMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  customerExternalIdExists: vi.fn(),
  createRule: vi.fn(),
  listRules: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('@/lib/rules/repository', () => ({
  createRule: routeMocks.createRule,
  listRules: routeMocks.listRules,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: routeMocks.auditLog,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: routeMocks.withRLS,
}));

vi.mock('@/lib/customers/lookup', () => ({
  customerExternalIdExists: routeMocks.customerExternalIdExists,
}));

const { POST } = await import('../../src/app/api/v1/rules/route.js');

function makeDashboardRequest(
  body: Record<string, unknown>,
  role: 'owner' | 'member' = 'owner',
): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-builder-id': '00000000-0000-4000-8000-000000000001',
      'x-user-id': 'user-1',
      'x-user-role': role,
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function lastCreateRuleInput(): Record<string, unknown> {
  const input = routeMocks.createRule.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  if (!input) throw new Error('createRule was not called');
  return input;
}

describe('POST /api/v1/rules validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.withRLS.mockImplementation(
      async (_builderId: string, cb: (tx: unknown) => unknown) => cb({ tx: true }),
    );
    routeMocks.customerExternalIdExists.mockResolvedValue(true);
    routeMocks.createRule.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'rule-created',
      builder_id: input['builder_id'],
      type: input['type'],
      enforcement: input['enforcement'] ?? 'post_call',
      name: input['name'],
      enabled: input['enabled'] ?? true,
      customer_id: input['customer_id'] ?? null,
      config: input['config'],
      status: input['status'] ?? RuleStatus.ACTIVE,
      activated_at: null,
      last_triggered_at: null,
      last_error: null,
      created_at: new Date('2026-06-01T00:00:00Z'),
      updated_at: new Date('2026-06-01T00:00:00Z'),
    }));
  });

  it.each([
    [
      RuleType.COST_THRESHOLD,
      {
        threshold_usd: 25,
        period: RulePeriod.DAY,
        scope: RuleScope.PER_CUSTOMER,
      },
    ],
    [
      RuleType.BUDGET_LIMIT,
      {
        limit_usd: 50,
        period: RulePeriod.DAY,
        hard_stop: true,
        scope: RuleScope.PER_CUSTOMER,
      },
    ],
  ])('creates owner %s rules as active by repository default', async (type, config) => {
    const response = await POST(
      makeDashboardRequest({
        type,
        name: `${type} rule`,
        enabled: true,
        customer_id: null,
        config,
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      rule: {
        builder_id: '00000000-0000-4000-8000-000000000001',
        type,
        status: RuleStatus.ACTIVE,
      },
    });
    const input = lastCreateRuleInput();
    expect(input).toMatchObject({
      builder_id: '00000000-0000-4000-8000-000000000001',
      type,
    });
    expect(input).not.toHaveProperty('status');
  });

  it('creates advanced rules as drafts for owner review', async () => {
    const response = await POST(
      makeDashboardRequest({
        type: RuleType.MARGIN_PROTECTION,
        name: 'break-even margin',
        enabled: true,
        customer_id: null,
        config: {
          margin_threshold_pct: 0,
          period: RulePeriod.DAY,
          scope: RuleScope.PER_CUSTOMER,
        },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      rule: {
        type: RuleType.MARGIN_PROTECTION,
        status: RuleStatus.DRAFT,
      },
    });
    expect(lastCreateRuleInput()).toMatchObject({
      type: RuleType.MARGIN_PROTECTION,
      status: RuleStatus.DRAFT,
      config: expect.objectContaining({ margin_threshold_pct: 0 }),
    });
  });

  it('allows members to create rules', async () => {
    const response = await POST(
      makeDashboardRequest(
        {
          type: RuleType.COST_THRESHOLD,
          name: 'member rule',
          config: {
            threshold_usd: 25,
            period: RulePeriod.DAY,
            scope: RuleScope.PER_CUSTOMER,
          },
        },
        'member',
      ),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      rule: {
        type: RuleType.COST_THRESHOLD,
        status: RuleStatus.ACTIVE,
      },
    });
    const input = lastCreateRuleInput();
    expect(input).toMatchObject({
      builder_id: '00000000-0000-4000-8000-000000000001',
      type: RuleType.COST_THRESHOLD,
    });
    expect(input).not.toHaveProperty('status');
  });

  it('creates a targeted rule for an existing selected end-user', async () => {
    const response = await POST(
      makeDashboardRequest({
        type: RuleType.BUDGET_LIMIT,
        name: 'selected customer budget',
        enabled: true,
        customer_id: 'alice',
        config: {
          limit_usd: 50,
          period: RulePeriod.DAY,
          hard_stop: true,
          scope: RuleScope.PER_CUSTOMER,
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(routeMocks.customerExternalIdExists).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'alice',
    );
    expect(lastCreateRuleInput()).toMatchObject({ customer_id: 'alice' });
  });

  it('rejects targeted rules for unknown end-users', async () => {
    routeMocks.customerExternalIdExists.mockResolvedValueOnce(false);

    const response = await POST(
      makeDashboardRequest({
        type: RuleType.BUDGET_LIMIT,
        name: 'unknown customer budget',
        enabled: true,
        customer_id: 'missing-user',
        config: {
          limit_usd: 50,
          period: RulePeriod.DAY,
          hard_stop: true,
          scope: RuleScope.PER_CUSTOMER,
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        param: 'customer_id',
        message: 'Select an existing end-user for this rule.',
      },
    });
    expect(routeMocks.createRule).not.toHaveBeenCalled();
  });

  it.each([
    [
      'zero cost threshold',
      {
        type: RuleType.COST_THRESHOLD,
        name: 'bad threshold',
        config: { threshold_usd: 0, period: RulePeriod.DAY, scope: RuleScope.PER_CUSTOMER },
      },
      'config.threshold_usd',
    ],
    [
      'negative budget limit',
      {
        type: RuleType.BUDGET_LIMIT,
        name: 'bad budget',
        config: {
          limit_usd: -1,
          period: RulePeriod.DAY,
          hard_stop: true,
          scope: RuleScope.PER_CUSTOMER,
        },
      },
      'config.limit_usd',
    ],
    [
      'negative margin threshold',
      {
        type: RuleType.MARGIN_PROTECTION,
        name: 'bad margin',
        config: {
          margin_threshold_pct: -0.01,
          period: RulePeriod.DAY,
          scope: RuleScope.PER_CUSTOMER,
        },
      },
      'config.margin_threshold_pct',
    ],
    [
      'missing required field',
      {
        type: RuleType.COST_THRESHOLD,
        name: 'missing period',
        config: { threshold_usd: 25, scope: RuleScope.PER_CUSTOMER },
      },
      'config.period',
    ],
    [
      'wrong value type',
      {
        type: RuleType.BUDGET_LIMIT,
        name: 'wrong type',
        config: {
          limit_usd: '50',
          period: RulePeriod.DAY,
          hard_stop: true,
          scope: RuleScope.PER_CUSTOMER,
        },
      },
      'config.limit_usd',
    ],
    [
      'unknown rule type',
      {
        type: 'not_a_rule',
        name: 'unknown',
        config: {},
      },
      'type',
    ],
  ])('returns 400 with a field error for %s', async (_label, body, param) => {
    const response = await POST(makeDashboardRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        param,
      },
    });
    expect(routeMocks.createRule).not.toHaveBeenCalled();
  });

  it.each([
    ['active payload', {}],
    ['draft payload', { status: RuleStatus.DRAFT }],
  ])('rejects removed customer_throttle rules for %s', async (_label, overrides) => {
    const response = await POST(
      makeDashboardRequest({
        type: 'customer_throttle',
        name: 'removed rule',
        config: { trigger: 'manual' },
        ...overrides,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        param: 'type',
        message:
          "Rule type 'customer_throttle' has been removed. Use budget_limit hard stops to cap customer usage.",
      },
    });
    expect(routeMocks.createRule).not.toHaveBeenCalled();
  });

  // F6 (B6): drafts previously bypassed the type check entirely, so a
  // made-up type persisted a row that could never activate (activation now
  // schema-validates against the per-type create schema).
  it('rejects unknown rule types for drafts too', async () => {
    const response = await POST(
      makeDashboardRequest({
        type: 'made_up_type',
        name: 'mystery draft',
        config: {},
        status: RuleStatus.DRAFT,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        param: 'type',
        message: "Rule type 'made_up_type' is not supported",
      },
    });
    expect(routeMocks.createRule).not.toHaveBeenCalled();
  });

  it('still accepts supported-type drafts with free-form config', async () => {
    const response = await POST(
      makeDashboardRequest({
        type: RuleType.MODEL_ROUTING,
        name: 'simulator draft',
        config: { anything: 'goes-for-drafts' },
        status: RuleStatus.DRAFT,
      }),
    );

    expect(response.status).toBe(201);
    expect(routeMocks.createRule).toHaveBeenCalledWith(
      expect.objectContaining({
        type: RuleType.MODEL_ROUTING,
        status: RuleStatus.DRAFT,
        enabled: false,
        config: { anything: 'goes-for-drafts' },
      }),
    );
  });
});
