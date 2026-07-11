import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server.js';
import React from 'react';
import { ErrorCode, VisibilityLevel } from '@pylva/shared';

const authMock = vi.fn();
const entitlementMock = vi.fn();
const overviewMock = vi.fn();
const byModelMock = vi.fn();
const byStepMock = vi.fn();
const trendMock = vi.fn();
const rangeMock = vi.fn();

vi.stubGlobal('React', React);

vi.mock('../../src/lib/portal/auth.js', () => ({
  authenticatePortalToken: authMock,
}));

vi.mock('../../src/lib/portal/entitlement.js', () => ({
  checkPortalEntitlement: entitlementMock,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  company_name: 'Acme',
                  logo_url: null,
                  primary_color: '#4f46e5',
                  visibility_level: VisibilityLevel.AGGREGATE_ONLY,
                  show_usage_trend: false,
                },
              ]),
          }),
        }),
      }),
    }),
}));

vi.mock('../../src/lib/portal/data.js', () => ({
  getPortalOverview: overviewMock,
  getPortalBreakdownByModel: byModelMock,
  getPortalBreakdownByStep: byStepMock,
  getPortalDailyTrend: trendMock,
  resolvePortalRange: rangeMock,
}));

const { default: PortalPage } = await import('../../src/app/portal/page.js');

const OK_CTX = {
  kind: 'ok' as const,
  ctx: {
    builderId: 'builder-1',
    customerId: 'customer-1',
    jti: 'jti-1',
    linkId: 'link-1',
    sessionExpiresAt: new Date('2026-07-01T12:00:00Z'),
  },
};

function textContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'object' && 'props' in node) {
    const element = node as {
      type?: unknown;
      props?: { children?: unknown };
    };
    if (typeof element.type === 'function') return textContent(element.type(element.props));
    return textContent(element.props?.children);
  }
  return '';
}

function pageProps(token = 'token') {
  return { searchParams: Promise.resolve({ token }) };
}

describe('/portal entitlement', () => {
  beforeEach(() => {
    authMock.mockReset();
    entitlementMock.mockReset();
    overviewMock.mockReset();
    byModelMock.mockReset();
    byStepMock.mockReset();
    trendMock.mockReset();
    rangeMock.mockReset();
    authMock.mockResolvedValue(OK_CTX);
    entitlementMock.mockResolvedValue(null);
    rangeMock.mockResolvedValue({
      from: new Date('2026-07-01T00:00:00Z'),
      to: new Date('2026-07-01T12:00:00Z'),
      source: 'month_to_date',
    });
    overviewMock.mockResolvedValue({ total_cost_usd: 12.5, event_count: 7 });
    byModelMock.mockResolvedValue([]);
    byStepMock.mockResolvedValue([]);
    trendMock.mockResolvedValue([]);
  });

  it('renders portal unavailable when a valid token belongs to a non-entitled workspace', async () => {
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

    const element = await PortalPage(pageProps());

    expect(textContent(element)).toContain('Portal unavailable');
    expect(textContent(element)).toContain("builder's current plan");
    expect(rangeMock).not.toHaveBeenCalled();
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it('renders neutral unavailable copy when the builder no longer exists', async () => {
    entitlementMock.mockResolvedValue(
      NextResponse.json(
        {
          error: {
            code: ErrorCode.RESOURCE_NOT_FOUND,
            message: 'Builder not found',
          },
        },
        { status: 404 },
      ),
    );

    const element = await PortalPage(pageProps());
    const text = textContent(element);

    expect(text).toContain('Portal unavailable');
    expect(text).toContain('This portal is currently unavailable.');
    expect(text).not.toContain("builder's current plan");
    expect(rangeMock).not.toHaveBeenCalled();
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it('renders usage data when the workspace is entitled', async () => {
    const element = await PortalPage(pageProps());
    const text = textContent(element);

    expect(text).toContain('Acme');
    expect(text).toContain('$12.50');
    expect(text).toContain('7 events');
    expect(entitlementMock).toHaveBeenCalledWith('builder-1');
  });
});
