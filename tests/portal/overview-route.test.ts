// Regression test: GET /api/portal/overview must honor
// portal_configs.visibility_level. Previously the JSON API always returned
// `breakdown.by_model`, ignoring the gate the portal *page* enforces — so a
// customer holding a valid portal token could read the builder-confidential
// per-model cost split (which providers/models power the product) by hitting
// the API directly, even when the builder set visibility_level=AGGREGATE_ONLY
// (the schema default).
//
// Mocks auth + data + the config lookup so we exercise the route's gating
// branch without a DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server.js';
import { ErrorCode, VisibilityLevel } from '@pylva/shared';

const authMock = vi.fn();
const entitlementMock = vi.fn();
const overviewMock = vi.fn();
const byModelMock = vi.fn();
const rangeMock = vi.fn();

// Controls the visibility_level the mocked portal_configs row reports.
let visibilityRow: { visibility_level: string } | undefined;

vi.mock('../../src/lib/portal/auth.js', () => ({
  authenticatePortalToken: authMock,
}));

vi.mock('../../src/lib/portal/entitlement.js', () => ({
  checkPortalEntitlement: entitlementMock,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: async (_b: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(visibilityRow ? [visibilityRow] : []),
          }),
        }),
      }),
    }),
}));

vi.mock('../../src/lib/portal/data.js', () => ({
  getPortalOverview: overviewMock,
  getPortalBreakdownByModel: byModelMock,
  resolvePortalRange: rangeMock,
}));

const { GET } = await import('../../src/app/api/portal/overview/route.js');

function makeRequest(token = 'tok'): import('next/server.js').NextRequest {
  return new Request(
    `http://localhost/api/portal/overview?token=${token}`,
  ) as unknown as import('next/server.js').NextRequest;
}

const OK_CTX = {
  kind: 'ok' as const,
  ctx: {
    builderId: 'b-1',
    customerId: 'c-1',
    jti: 'j-1',
    linkId: 'l-1',
    sessionExpiresAt: new Date('2026-06-08T00:00:00Z'),
  },
};

const RANGE = {
  from: new Date('2026-06-01T00:00:00Z'),
  to: new Date('2026-06-08T00:00:00Z'),
  source: 'month_to_date' as const,
};

describe('GET /api/portal/overview — visibility_level gating', () => {
  beforeEach(() => {
    visibilityRow = undefined;
    authMock.mockReset();
    entitlementMock.mockReset();
    overviewMock.mockReset();
    byModelMock.mockReset();
    rangeMock.mockReset();
    authMock.mockResolvedValue(OK_CTX);
    entitlementMock.mockResolvedValue(null);
    rangeMock.mockResolvedValue(RANGE);
    overviewMock.mockResolvedValue({ total_cost_usd: 12.5, event_count: 7 });
    byModelMock.mockResolvedValue([
      { key: 'gpt-4o', cost_usd: 10, event_count: 5 },
      { key: 'claude-opus-4', cost_usd: 2.5, event_count: 2 },
    ]);
  });

  it('returns 403 for a valid token when the builder no longer has portal access', async () => {
    entitlementMock.mockResolvedValue(
      NextResponse.json(
        {
          error: {
            code: ErrorCode.FEATURE_NOT_AVAILABLE,
            message: 'portal is not available on the free tier',
          },
        },
        { status: 403 },
      ),
    );

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe(ErrorCode.FEATURE_NOT_AVAILABLE);
    expect(rangeMock).not.toHaveBeenCalled();
    expect(overviewMock).not.toHaveBeenCalled();
    expect(byModelMock).not.toHaveBeenCalled();
  });

  it('suppresses by_model when visibility_level = AGGREGATE_ONLY', async () => {
    visibilityRow = { visibility_level: VisibilityLevel.AGGREGATE_ONLY };
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.overview).toEqual({ total_cost_usd: 12.5, event_count: 7 });
    expect(body.breakdown.by_model).toEqual([]);
    // The expensive breakdown query must not even run when it's gated off.
    expect(byModelMock).not.toHaveBeenCalled();
  });

  it('suppresses by_model when no portal_configs row exists (defaults to AGGREGATE_ONLY)', async () => {
    visibilityRow = undefined;
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.breakdown.by_model).toEqual([]);
    expect(byModelMock).not.toHaveBeenCalled();
  });

  it('returns by_model when visibility_level = CATEGORY_MODEL', async () => {
    visibilityRow = { visibility_level: VisibilityLevel.CATEGORY_MODEL };
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(byModelMock).toHaveBeenCalledOnce();
    expect(body.breakdown.by_model).toHaveLength(2);
    expect(body.breakdown.by_model[0].key).toBe('gpt-4o');
  });

  it('returns by_model when visibility_level = STEP_LEVEL', async () => {
    visibilityRow = { visibility_level: VisibilityLevel.STEP_LEVEL };
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(byModelMock).toHaveBeenCalledOnce();
    expect(body.breakdown.by_model).toHaveLength(2);
  });
});
