import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode, RuleStatus, RuleType } from '@pylva/shared';
import { AuditAction } from '../../src/lib/audit/actions.js';

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

function request(method: 'GET' | 'DELETE', role: 'owner' | 'member'): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/rule-1', {
    method,
    headers: {
      'x-builder-id': BUILDER_ID,
      'x-user-id': 'user-1',
      'x-user-role': role,
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

const params = { params: Promise.resolve({ id: 'rule-1' }) };

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

describe('GET /api/v1/rules/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRule.mockResolvedValue(ruleRow());
  });

  it('returns { rule } for any member of the builder', async () => {
    const response = await route.GET(request('GET', 'member'), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rule: ruleRow() });
    expect(mocks.getRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1');
  });

  it('returns 404 for a cross-tenant or nonexistent rule id', async () => {
    mocks.getRule.mockResolvedValueOnce(null);

    const response = await route.GET(request('GET', 'owner'), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.NOT_FOUND },
    });
  });
});

describe('DELETE /api/v1/rules/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteRule.mockResolvedValue(true);
  });

  it('keeps delete Owner-only', async () => {
    const response = await route.DELETE(request('DELETE', 'member'), params);

    expect(response.status).toBe(403);
    expect(mocks.deleteRule).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('returns 404 without an audit entry when nothing was deleted', async () => {
    mocks.deleteRule.mockResolvedValueOnce(false);

    const response = await route.DELETE(request('DELETE', 'owner'), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.NOT_FOUND },
    });
    expect(mocks.deleteRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1');
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('deletes as owner and writes a rule.delete audit entry', async () => {
    const response = await route.DELETE(request('DELETE', 'owner'), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.deleteRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1');
    expect(mocks.withRLS).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        builder_id: BUILDER_ID,
        actor_type: 'user',
        actor_id: 'user-1',
        action: AuditAction.RULE_DELETE,
        resource_type: 'rule',
        resource_id: 'rule-1',
      }),
    );
  });
});
