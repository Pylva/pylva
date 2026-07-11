// Authorization regression - POST /api/v1/cost-sources role gate.
//
// Root cause: the dashboard-JWT path of POST had no role check, while the
// sibling PATCH is Owner-only ("Members can read but not mutate cost-source
// rows", O18 + security defaults). A Member could therefore create a priced,
// approved cost source - a pricing mutation reserved for Owners - bypassing the
// PATCH gate by creating a new row instead of editing one.
//
// Pure unit test: the role gate returns before any DB access, and the DB layer
// is mocked, so no Postgres is required. This file intentionally lives outside
// tests/security/** so the default `pnpm test` lane loads it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server.js';

const routeMocks = vi.hoisted(() => ({
  dashboardCtx: {
    builderId: '00000000-0000-4000-8000-000000000001',
    userId: 'user-1',
    role: 'owner' as string | null,
  },
  apiKeyCtx: {
    builderId: '00000000-0000-4000-8000-000000000001',
    keyId: 'cli-key-1',
  },
  withRLS: vi.fn(),
  withRole: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({ ...routeMocks.dashboardCtx }),
  readBuilderContext: () => ({ ...routeMocks.apiKeyCtx }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  Role: { MEMBER: 'member', OWNER: 'owner' },
  withRole: routeMocks.withRole,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: routeMocks.withRLS,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: routeMocks.auditLog,
}));

vi.mock('@/lib/db/client', () => ({
  db: {},
  sql: {},
}));

const { POST } = await import('../../src/app/api/v1/cost-sources/route.js');

const INSERTED_ROW = {
  id: '00000000-0000-4000-8000-0000000000aa',
  builder_id: '00000000-0000-4000-8000-000000000001',
  source_type: 'non_llm_manual',
  display_name: 'ElevenLabs',
  slug: 'elevenlabs',
  metric: null,
  unit: null,
  price_per_unit: '0.10',
  pricing_tiers: null,
  status: 'active',
  tracking_status: 'tracked',
  matchers: ['elevenlabs'],
  default_metric_value: 1,
  last_seen_at: null,
  last_discovered_at: null,
  discovery_count: 0,
  approved_at: new Date('2026-07-05T00:00:00Z'),
  created_at: new Date('2026-07-05T00:00:00Z'),
};

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Only owner can perform this action' } },
    { status: 403 },
  );
}

function postRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/v1/cost-sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      display_name: 'ElevenLabs',
      slug: 'elevenlabs',
      source_type: 'non_llm_manual',
      metric: 'elevenlabs_tokens',
      unit: 'token',
      price_per_unit: 0.1,
    }),
  }) as unknown as import('next/server.js').NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.dashboardCtx.role = 'owner';
  routeMocks.withRole.mockImplementation((allowed: string[], role: string | null) =>
    role !== null && allowed.includes(role) ? null : forbidden(),
  );
  routeMocks.withRLS.mockResolvedValue(INSERTED_ROW);
});

describe('POST /api/v1/cost-sources dashboard role gate', () => {
  it('rejects a Member dashboard caller with 403 before any DB write', async () => {
    routeMocks.dashboardCtx.role = 'member';

    const response = await POST(postRequest());

    expect(response.status).toBe(403);
    expect(routeMocks.withRLS).not.toHaveBeenCalled();
    expect(routeMocks.withRole).toHaveBeenCalledWith(['owner'], 'member');
  });

  it('allows an Owner dashboard caller to create the cost source', async () => {
    routeMocks.dashboardCtx.role = 'owner';

    const response = await POST(postRequest());

    expect(response.status).toBe(201);
    expect(routeMocks.withRLS).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      cost_source: { slug: 'elevenlabs', builder_id: routeMocks.dashboardCtx.builderId },
    });
  });

  it('leaves the API-key machine path ungated (universal key via either auth header)', async () => {
    const response = await POST(postRequest({ 'x-key-id': 'cli-key-1' }));

    expect(response.status).toBe(201);
    expect(routeMocks.withRole).not.toHaveBeenCalled();
    expect(routeMocks.withRLS).toHaveBeenCalledTimes(1);
  });
});
