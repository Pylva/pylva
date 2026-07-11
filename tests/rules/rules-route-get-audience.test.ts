import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';
import { ErrorCode, RuleStatus, RuleType } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  createRule: vi.fn(),
  customerExternalIdExists: vi.fn(),
  listRules: vi.fn(),
  readBuilderContext: vi.fn(),
  readBuilderContextFromDashboard: vi.fn(),
  withRLS: vi.fn(async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({ tx: true }),
  ),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContext: mocks.readBuilderContext,
  readBuilderContextFromDashboard: mocks.readBuilderContextFromDashboard,
}));

vi.mock('@/lib/rules/repository', () => ({
  createRule: mocks.createRule,
  listRules: mocks.listRules,
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

const route = await import('../../src/app/api/v1/rules/route.js');

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules', {
    method: 'GET',
    headers,
  } as ConstructorParameters<typeof NextRequest>[1]);
}

// SDK fetch: middleware validated an Agent SDK key and stamped x-key-id.
function sdkRequest(): NextRequest {
  return request({ 'x-builder-id': BUILDER_ID, 'x-key-id': 'key-1' });
}

// Dashboard fetch: JWT auth — no x-key-id, user claims instead.
function dashboardRequest(): NextRequest {
  return request({ 'x-builder-id': BUILDER_ID, 'x-user-id': 'user-1', 'x-user-role': 'owner' });
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

function deniedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: {
        type: 'authentication_error',
        code: ErrorCode.INVALID_API_KEY,
        message: 'Invalid API key',
      },
    },
    { status: 401 },
  );
}

describe('GET /api/v1/rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRules.mockResolvedValue([ruleRow()]);
    mocks.readBuilderContext.mockReturnValue({ builderId: BUILDER_ID, keyId: 'key-1' });
    mocks.readBuilderContextFromDashboard.mockReturnValue({
      builderId: BUILDER_ID,
      userId: 'user-1',
      role: 'owner',
    });
  });

  it('serves the SDK audience (x-key-id) only enabled, non-draft, pre-call rules', async () => {
    const response = await route.GET(sdkRequest());

    expect(response.status).toBe(200);
    expect(mocks.readBuilderContext).toHaveBeenCalledTimes(1);
    expect(mocks.readBuilderContextFromDashboard).not.toHaveBeenCalled();
    expect(mocks.listRules).toHaveBeenCalledWith(BUILDER_ID, {
      excludeDrafts: true,
      excludeDisabled: true,
      enforcement: 'pre_call',
    });
  });

  it('serves the dashboard audience (no x-key-id) the unfiltered list', async () => {
    const response = await route.GET(dashboardRequest());

    expect(response.status).toBe(200);
    expect(mocks.readBuilderContextFromDashboard).toHaveBeenCalledTimes(1);
    expect(mocks.readBuilderContext).not.toHaveBeenCalled();
    expect(mocks.listRules).toHaveBeenCalledWith(BUILDER_ID, undefined);
  });

  it('returns the RulesResponse cache contract { rules, ttl_seconds, fetched_at }', async () => {
    const response = await route.GET(dashboardRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rules: unknown;
      ttl_seconds: number;
      fetched_at: string;
    };
    expect(body.rules).toEqual([ruleRow()]);
    expect(body.ttl_seconds).toBe(60);
    expect(typeof body.fetched_at).toBe('string');
    // ISO-8601: parse + re-serialize is the identity.
    expect(new Date(body.fetched_at).toISOString()).toBe(body.fetched_at);
  });

  it('returns an SDK auth failure as-is without listing rules', async () => {
    const denied = deniedResponse();
    mocks.readBuilderContext.mockReturnValueOnce(denied);

    const response = await route.GET(sdkRequest());

    expect(response).toBe(denied);
    expect(response.status).toBe(401);
    expect(mocks.listRules).not.toHaveBeenCalled();
  });

  it('returns a dashboard auth failure as-is without listing rules', async () => {
    const denied = deniedResponse();
    mocks.readBuilderContextFromDashboard.mockReturnValueOnce(denied);

    const response = await route.GET(dashboardRequest());

    expect(response).toBe(denied);
    expect(response.status).toBe(401);
    expect(mocks.listRules).not.toHaveBeenCalled();
  });
});
