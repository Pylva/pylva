// SEO/privacy regression — /portal must never enter a search index.
//
// Portal links are bearer-token URLs shared with end customers; if one leaks
// into any crawled page, the customer's spend data could be indexed. The
// hosted robots.txt Disallow alone does not prevent indexing of a linked URL
// (and a disallowed page can't be crawled to see an HTML noindex), so the
// middleware sets `X-Robots-Tag: noindex` at the HTTP layer for every /portal
// and /api/portal response — on every auth outcome, including tokenless and
// garbage-token requests.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/auth/middleware.js', () => ({
  withApiKeyAuth: vi.fn(async () => ({ builderId: 'b-1', scope: 'agent_sdk', keyId: 'k-1' })),
  withJwtAuth: vi.fn(async () => ({
    context: { builderId: 'b-1', userId: 'u-1', role: 'owner', tier: 'free', jti: 'j-1' },
    refreshToken: null,
  })),
  withRateLimit: vi.fn(async () => null),
  withMembership: vi.fn(async () => ({ builderId: 'b-1', role: 'owner', tier: 'free' })),
  setRefreshCookie: vi.fn(),
  RATE_LIMIT_PRESETS: {
    telemetry: { maxRequests: 1000, windowMs: 60_000 },
    controlPlane: { maxRequests: 100, windowMs: 60_000 },
    dashboardRead: { maxRequests: 120, windowMs: 60_000 },
    dashboardWrite: { maxRequests: 30, windowMs: 60_000 },
  },
}));

// The middleware imports this lazily inside the /portal branch; mock it so the
// test needs no Redis. Fail-open default mirrors production behaviour.
vi.mock('../../src/lib/portal/iframe-csp.js', () => ({
  buildPortalFrameAncestors: vi.fn(async () => "frame-ancestors 'self'"),
}));

const { NextRequest } = await import('next/server.js');
const { middleware } = await import('../../src/middleware.js');

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    headers,
  } as ConstructorParameters<typeof NextRequest>[1]);
}

describe('portal responses carry X-Robots-Tag: noindex', () => {
  it('tokenless /portal (error branch) is noindex', async () => {
    const res = await middleware(req('/portal'));
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('garbage ?token= is still noindex', async () => {
    const res = await middleware(req('/portal?token=not-a-real-token'));
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('bearer-token portal request is noindex', async () => {
    const res = await middleware(req('/portal', { authorization: 'Bearer abc123' }));
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('portal API surface is noindex', async () => {
    const res = await middleware(req('/api/portal/overview?token=x'));
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('keeps the portal CSP/referrer hardening alongside the robots header', async () => {
    const res = await middleware(req('/portal'));
    expect(res.headers.get('Content-Security-Policy')).toContain('frame-ancestors');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('does not leak the header onto non-portal routes', async () => {
    const res = await middleware(req('/api/v1/health'));
    expect(res.headers.get('X-Robots-Tag')).toBeNull();
  });
});
