import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode, PortalLinkStatus, PortalLinkType } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  checkDashboardFeatureGate: vi.fn(),
  checkFeatureGate: vi.fn(),
  getBuilderTierGate: vi.fn(),
  checkPortalEntitlement: vi.fn(),
  checkPortalEntitlementForTier: vi.fn(),
  signJwt: vi.fn(),
  withRLS: vi.fn(),
  ctx: {
    builderId: '00000000-0000-0000-0000-000000000001',
    userId: 'user-1',
    role: 'owner',
  },
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({ ...mocks.ctx }),
}));
vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({ ...mocks.ctx }),
}));

vi.mock('../../src/lib/auth/dashboard-feature-gate.js', () => ({
  checkDashboardFeatureGate: mocks.checkDashboardFeatureGate,
  getBuilderTierGate: mocks.getBuilderTierGate,
}));
vi.mock('@/lib/auth/dashboard-feature-gate', () => ({
  checkDashboardFeatureGate: mocks.checkDashboardFeatureGate,
  getBuilderTierGate: mocks.getBuilderTierGate,
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkFeatureGate: mocks.checkFeatureGate,
}));

vi.mock('../../src/lib/auth/middleware.js', () => ({
  Role: { OWNER: 'owner', MEMBER: 'member' },
  withRole: () => null,
}));
vi.mock('@/lib/auth/middleware', () => ({
  Role: { OWNER: 'owner', MEMBER: 'member' },
  withRole: () => null,
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({
  auditLog: mocks.auditLog,
}));
vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('../../src/lib/auth/jwt.js', () => ({
  signJwt: mocks.signJwt,
}));
vi.mock('@/lib/auth/jwt', () => ({
  signJwt: mocks.signJwt,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));
vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/portal/entitlement.js', () => ({
  checkPortalEntitlement: mocks.checkPortalEntitlement,
  checkPortalEntitlementForTier: mocks.checkPortalEntitlementForTier,
}));
vi.mock('@/lib/portal/entitlement', () => ({
  checkPortalEntitlement: mocks.checkPortalEntitlement,
  checkPortalEntitlementForTier: mocks.checkPortalEntitlementForTier,
}));

const configRoute = await import('../../src/app/api/v1/portal/config/route.js');
const linksRoute = await import('../../src/app/api/v1/portal/links/route.js');
const revokeRoute = await import('../../src/app/api/v1/portal/links/[id]/revoke/route.js');

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const LINK_ID = '22222222-2222-2222-2222-222222222222';
const EXPIRES_AT = new Date('2026-07-02T00:00:00Z');

let selectRows: unknown[] = [];
let insertRows: unknown[] = [];
let updateRows: unknown[] = [];

function featureUnavailable(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: ErrorCode.FEATURE_NOT_AVAILABLE,
        message: 'portal is not available on the free tier',
      },
    },
    { status: 403 },
  );
}

function makeRequest(
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  }) as unknown as NextRequest;
}

function makeJwtPayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function tx() {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve(selectRows),
  };
  const insertValuesChain = {
    onConflictDoUpdate: () => ({ returning: () => Promise.resolve(insertRows) }),
    returning: () => Promise.resolve(insertRows),
  };
  const updateWhereChain = {
    returning: () => Promise.resolve(updateRows),
  };
  return {
    select: () => selectChain,
    insert: () => ({ values: () => insertValuesChain }),
    update: () => ({ set: () => ({ where: () => updateWhereChain }) }),
    delete: () => ({ where: () => Promise.resolve([]) }),
  };
}

describe('portal entitlement routes', () => {
  beforeEach(() => {
    selectRows = [];
    insertRows = [];
    updateRows = [];
    mocks.auditLog.mockReset();
    mocks.checkDashboardFeatureGate.mockReset();
    mocks.checkFeatureGate.mockReset();
    mocks.getBuilderTierGate.mockReset();
    mocks.checkPortalEntitlement.mockReset();
    mocks.checkPortalEntitlementForTier.mockReset();
    mocks.signJwt.mockReset();
    mocks.withRLS.mockReset();
    mocks.checkDashboardFeatureGate.mockResolvedValue(null);
    mocks.getBuilderTierGate.mockResolvedValue('scale');
    mocks.checkPortalEntitlement.mockResolvedValue(null);
    mocks.checkPortalEntitlementForTier.mockImplementation((tier: string) =>
      tier === 'free' ? featureUnavailable() : null,
    );
    mocks.checkFeatureGate.mockImplementation((tier: string, feature: string) =>
      feature === 'white_label_portal' && (tier === 'free' || tier === 'pro')
        ? featureUnavailable()
        : null,
    );
    mocks.signJwt.mockResolvedValue(`h.${makeJwtPayload({ jti: 'jti-1' })}.s`);
    mocks.withRLS.mockImplementation(async (_builderId: string, cb: (arg: unknown) => unknown) =>
      cb(tx()),
    );
  });

  it('rejects builder-facing portal routes when the workspace is not entitled', async () => {
    mocks.checkPortalEntitlement.mockImplementation(async () => featureUnavailable());
    mocks.getBuilderTierGate.mockResolvedValue('free');

    const cases = [
      () => configRoute.GET(makeRequest('/api/v1/portal/config')),
      () =>
        configRoute.PUT(
          makeRequest('/api/v1/portal/config', {
            method: 'PUT',
            body: { company_name: 'Acme', show_invoices: false },
          }),
        ),
      () => linksRoute.GET(makeRequest('/api/v1/portal/links')),
      () =>
        linksRoute.POST(
          makeRequest('/api/v1/portal/links', {
            method: 'POST',
            body: { customer_id: CUSTOMER_ID },
          }),
        ),
      () =>
        revokeRoute.POST(
          makeRequest(`/api/v1/portal/links/${LINK_ID}/revoke`, { method: 'POST' }),
          {
            params: Promise.resolve({ id: LINK_ID }),
          },
        ),
    ];

    for (const run of cases) {
      const response = await run();
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe(ErrorCode.FEATURE_NOT_AVAILABLE);
    }
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });

  it('allows entitled workspaces to read and save portal config', async () => {
    selectRows = [{ company_name: 'Acme', show_invoices: false }];
    const getResponse = await configRoute.GET(makeRequest('/api/v1/portal/config'));
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      config: { company_name: 'Acme' },
    });

    insertRows = [{ id: 'cfg-1', company_name: 'Acme', show_invoices: false }];
    const putResponse = await configRoute.PUT(
      makeRequest('/api/v1/portal/config', {
        method: 'PUT',
        body: {
          company_name: 'Acme',
          logo_url: null,
          show_invoices: false,
          allowed_iframe_origins: [],
        },
      }),
    );
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({
      config: { company_name: 'Acme' },
    });
  });

  it('gates visual branding fields behind the white-label portal feature', async () => {
    mocks.getBuilderTierGate.mockResolvedValueOnce('pro');

    const proResponse = await configRoute.PUT(
      makeRequest('/api/v1/portal/config', {
        method: 'PUT',
        body: {
          logo_url: 'https://cdn.example.com/logo.png',
          primary_color: '#0d9488',
          secondary_color: '#0f766e',
          accent_color: '#14b8a6',
        },
      }),
    );

    expect(proResponse.status).toBe(403);
    await expect(proResponse.json()).resolves.toMatchObject({
      error: { code: ErrorCode.FEATURE_NOT_AVAILABLE },
    });
    expect(mocks.getBuilderTierGate).toHaveBeenCalledWith(mocks.ctx.builderId);

    mocks.getBuilderTierGate.mockResolvedValueOnce('scale');
    insertRows = [
      {
        id: 'cfg-1',
        logo_url: 'https://cdn.example.com/logo.png',
        primary_color: '#0d9488',
        secondary_color: '#0f766e',
        accent_color: '#14b8a6',
      },
    ];

    const scaleResponse = await configRoute.PUT(
      makeRequest('/api/v1/portal/config', {
        method: 'PUT',
        body: {
          logo_url: 'https://cdn.example.com/logo.png',
          primary_color: '#0d9488',
          secondary_color: '#0f766e',
          accent_color: '#14b8a6',
        },
      }),
    );

    expect(scaleResponse.status).toBe(200);
    await expect(scaleResponse.json()).resolves.toMatchObject({
      config: { logo_url: 'https://cdn.example.com/logo.png' },
    });
  });

  it('does not white-label gate company_name or non-branding portal fields', async () => {
    mocks.checkDashboardFeatureGate.mockImplementation(async () => featureUnavailable());
    insertRows = [{ id: 'cfg-1', company_name: 'Acme', show_invoices: false }];

    const response = await configRoute.PUT(
      makeRequest('/api/v1/portal/config', {
        method: 'PUT',
        body: {
          company_name: 'Acme',
          show_invoices: false,
          allowed_iframe_origins: [],
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      config: { company_name: 'Acme', show_invoices: false },
    });
    expect(mocks.checkDashboardFeatureGate).not.toHaveBeenCalled();
  });

  it('allows entitled workspaces to list, mint, and revoke portal links', async () => {
    selectRows = [
      {
        id: LINK_ID,
        customer_id: CUSTOMER_ID,
        jti: 'jti-1',
        link_type: PortalLinkType.STANDARD,
        status: PortalLinkStatus.ACTIVE,
        expires_at: EXPIRES_AT,
        created_at: new Date('2026-07-01T00:00:00Z'),
      },
    ];
    const listResponse = await linksRoute.GET(makeRequest('/api/v1/portal/links'));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      links: [{ id: LINK_ID, customer_id: CUSTOMER_ID }],
    });

    selectRows = [{ id: CUSTOMER_ID }];
    insertRows = [
      {
        id: LINK_ID,
        customer_id: CUSTOMER_ID,
        jti: 'jti-1',
        link_type: PortalLinkType.STANDARD,
        expires_at: EXPIRES_AT,
      },
    ];
    const mintResponse = await linksRoute.POST(
      makeRequest('/api/v1/portal/links', {
        method: 'POST',
        body: { customer_id: CUSTOMER_ID, link_type: PortalLinkType.STANDARD },
      }),
    );
    expect(mintResponse.status).toBe(201);
    await expect(mintResponse.json()).resolves.toMatchObject({
      link: { id: LINK_ID, token: expect.any(String) },
    });

    updateRows = [{ id: LINK_ID, jti: 'jti-1' }];
    const revokeResponse = await revokeRoute.POST(
      makeRequest(`/api/v1/portal/links/${LINK_ID}/revoke`, { method: 'POST' }),
      { params: Promise.resolve({ id: LINK_ID }) },
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toEqual({ ok: true });
  });

  it('rejects malformed portal link customer_id filters before querying Postgres', async () => {
    const response = await linksRoute.GET(
      makeRequest('/api/v1/portal/links?customer_id=not-a-uuid'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        param: 'customer_id',
      },
    });
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });
});
