// Security regression — middleware tenant-context header injection.
//
// The dashboard/API-key RLS model trusts the `x-builder-id` (and friends)
// REQUEST header that `src/middleware.ts` is supposed to inject after verifying
// the session. Two invariants are tested here:
//
//   1. The trusted context is forwarded to the route handler as a *request*
//      header — i.e. via `NextResponse.next({ request: { headers } })`. Setting
//      it with `response.headers.set(...)` only produces a *response* header,
//      which the handler never sees (it would instead read the client's own
//      request header).
//   2. A client-supplied `x-builder-id` is overridden by the authoritative,
//      session-derived value. Otherwise any authenticated caller could set
//      `x-builder-id: <victim>` and read/write another tenant's data
//      (RLS escape / cross-tenant access).
//
// Next encodes forwarded request headers onto the returned response via the
// `x-middleware-override-headers` manifest plus per-header
// `x-middleware-request-<name>` entries — that is the exact channel the handler
// reads, so asserting on it asserts the real security property.
//
// On the pre-fix middleware (response.headers.set) these assertions fail:
// there is no `x-middleware-request-*` entry and the spoofed value flows
// through untouched.

import { describe, it, expect, vi } from 'vitest';
import { sessionFingerprint } from '../../src/lib/auth/session-fingerprint.js';

const AUTHORITATIVE_BUILDER = '11111111-1111-1111-1111-111111111111';
const VICTIM_BUILDER = '22222222-2222-2222-2222-222222222222';
const AUTHORITATIVE_KEY_ID = 'authkey0';
const IDENTITY_CONTEXT_HEADERS = ['x-builder-id', 'x-key-id', 'x-user-id', 'x-user-role'] as const;

// Mock the auth helpers so the middleware's verify steps succeed without real
// JWT keys / Redis. The mocks always return the AUTHORITATIVE identity.
vi.mock('../../src/lib/auth/middleware.js', () => ({
  withApiKeyAuth: vi.fn(async () => ({
    builderId: AUTHORITATIVE_BUILDER,
    scope: 'universal',
    keyId: AUTHORITATIVE_KEY_ID,
  })),
  withJwtAuth: vi.fn(async () => ({
    context: {
      builderId: AUTHORITATIVE_BUILDER,
      userId: 'u-1',
      orgSlug: 'acme',
      role: 'owner',
      tier: 'free',
      jti: 'j-1',
      revocationId: 'family-1',
    },
    refreshToken: null,
    sessionToken: 'session-token',
  })),
  withRateLimit: vi.fn(async () => null),
  withMembership: vi.fn(async () => ({
    builderId: AUTHORITATIVE_BUILDER,
    role: 'owner',
    tier: 'free',
  })),
  requestHasActiveSession: vi.fn(() => true),
  setDashboardSessionCookies: vi.fn(),
  RATE_LIMIT_PRESETS: {
    telemetry: { maxRequests: 1000, windowMs: 60_000 },
    controlPlane: { maxRequests: 100, windowMs: 60_000 },
    dashboardRead: { maxRequests: 120, windowMs: 60_000 },
    dashboardWrite: { maxRequests: 30, windowMs: 60_000 },
  },
}));

const { NextRequest } = await import('next/server.js');
const { middleware } = await import('../../src/middleware.js');

function spoofedRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: {
      // Attacker attempts to scope the request to another tenant.
      'x-builder-id': VICTIM_BUILDER,
      'x-key-id': 'spoofed-key',
      'x-user-id': 'spoofed-user',
      'x-user-role': 'owner',
      'x-pathname': '/o/victim/dashboard',
      'x-pylva-org': 'acme',
      'x-pylva-page-session': sessionFingerprint('u-1'),
      ...(init.headers ?? {}),
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

/** The value the downstream handler will actually receive for a header. */
function forwardedRequestHeader(res: { headers: Headers }, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

function overrideHeaderNames(res: { headers: Headers }): string[] {
  return (res.headers.get('x-middleware-override-headers') ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('middleware injects trusted context as request headers (anti-spoofing)', () => {
  it('JWT dashboard route: x-builder-id forwarded as authoritative request header', async () => {
    const res = await middleware(spoofedRequest('/api/v1/customers'));

    expect(overrideHeaderNames(res)).toContain('x-builder-id');

    // The handler must see the session-derived builder, NOT the spoofed one.
    expect(forwardedRequestHeader(res, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
    expect(forwardedRequestHeader(res, 'x-builder-id')).not.toBe(VICTIM_BUILDER);
    expect(forwardedRequestHeader(res, 'x-user-id')).toBe('u-1');
    expect(forwardedRequestHeader(res, 'x-pathname')).toBe('/api/v1/customers');

    // And it must NOT be leaked back to the client as a response header.
    expect(res.headers.get('x-builder-id')).toBeNull();
  });

  it('Agent SDK API-key route: x-builder-id + x-key-id forwarded as authoritative request headers', async () => {
    const res = await middleware(
      spoofedRequest('/api/v1/events', {
        method: 'POST',
        headers: { 'X-Pylva-Key': 'pv_live_deadbeef_' + 'a'.repeat(32) },
      }),
    );

    expect(forwardedRequestHeader(res, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
    expect(forwardedRequestHeader(res, 'x-builder-id')).not.toBe(VICTIM_BUILDER);
    expect(forwardedRequestHeader(res, 'x-key-id')).toBe(AUTHORITATIVE_KEY_ID);
    expect(forwardedRequestHeader(res, 'x-key-id')).not.toBe('spoofed-key');
    expect(forwardedRequestHeader(res, 'x-pathname')).toBe('/api/v1/events');
  });

  it('whoami route: routed through Agent-SDK API-key auth with trusted context', async () => {
    const res = await middleware(
      spoofedRequest('/api/v1/whoami', {
        headers: { 'X-Pylva-Key': 'pv_live_deadbeef_' + 'a'.repeat(32) },
      }),
    );

    expect(forwardedRequestHeader(res, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
    expect(forwardedRequestHeader(res, 'x-builder-id')).not.toBe(VICTIM_BUILDER);
    expect(forwardedRequestHeader(res, 'x-key-id')).toBe(AUTHORITATIVE_KEY_ID);
    expect(forwardedRequestHeader(res, 'x-pathname')).toBe('/api/v1/whoami');

    // Universal-key auth is scope-less; the route still uses the SDK rate-limit pool.
    const { withApiKeyAuth, withRateLimit } = await import('../../src/lib/auth/middleware.js');
    expect(vi.mocked(withApiKeyAuth).mock.lastCall?.length).toBe(1);
    expect(vi.mocked(withRateLimit).mock.lastCall?.[0]).toBe(`agent_sdk:${AUTHORITATIVE_KEY_ID}`);
  });

  it('/o/{slug}/* membership route: x-builder-id/role forwarded, spoof stripped', async () => {
    const res = await middleware(spoofedRequest('/o/some-slug/settings'));

    expect(forwardedRequestHeader(res, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
    expect(forwardedRequestHeader(res, 'x-builder-id')).not.toBe(VICTIM_BUILDER);
    // Role comes from the verified membership row, not the client header.
    expect(forwardedRequestHeader(res, 'x-user-role')).toBe('owner');
    expect(forwardedRequestHeader(res, 'x-user-id')).toBe('u-1');
    expect(forwardedRequestHeader(res, 'x-pathname')).toBe('/o/some-slug/settings');
  });

  it('public passthrough route strips spoofed trusted headers', async () => {
    // /api/v1/health is unauthenticated; a spoofed x-builder-id must still be
    // dropped so a handler can never read an attacker-controlled value.
    const res = await middleware(
      spoofedRequest('/api/v1/health', {
        headers: { accept: 'application/json' },
      }),
    );

    const overrides = overrideHeaderNames(res);
    // A harmless header proves the request override channel was actually used.
    expect(overrides).toContain('accept');
    expect(forwardedRequestHeader(res, 'accept')).toBe('application/json');

    // Stripped: Next treats the override manifest as the complete forwarded
    // request header set. Deleted trusted headers must be absent from that set.
    for (const header of IDENTITY_CONTEXT_HEADERS) {
      expect(overrides).not.toContain(header);
      expect(forwardedRequestHeader(res, header)).toBeNull();
      expect(res.headers.get(header)).toBeNull();
    }
    expect(overrides).toContain('x-pathname');
    expect(forwardedRequestHeader(res, 'x-pathname')).toBe('/api/v1/health');
    expect(res.headers.get('x-pathname')).toBeNull();
  });

  it('logout route passes through unauthenticated so it can clear expired sessions', async () => {
    const res = await middleware(spoofedRequest('/api/v1/auth/logout', { method: 'POST' }));

    const overrides = overrideHeaderNames(res);
    for (const header of IDENTITY_CONTEXT_HEADERS) {
      expect(overrides).not.toContain(header);
      expect(forwardedRequestHeader(res, header)).toBeNull();
      expect(res.headers.get(header)).toBeNull();
    }
    expect(overrides).toContain('x-pathname');
    expect(forwardedRequestHeader(res, 'x-pathname')).toBe('/api/v1/auth/logout');
  });
});

// One universal key: POST /api/v1/cost-sources must route to the machine path
// for a key sent via EITHER auth header (SDKs send X-Pylva-Key, the CLI sends
// Bearer) — otherwise the same key would work on /events but 401 here.
// Browser calls send neither header and stay on the dashboard JWT path.
describe('middleware cost-sources POST auth dispatch', () => {
  it('routes an X-Pylva-Key caller to the machine path (x-key-id forwarded)', async () => {
    const res = await middleware(
      spoofedRequest('/api/v1/cost-sources', {
        method: 'POST',
        headers: { 'X-Pylva-Key': 'pv_live_deadbeef_' + 'a'.repeat(32) },
      }),
    );

    expect(forwardedRequestHeader(res, 'x-key-id')).toBe(AUTHORITATIVE_KEY_ID);
    expect(forwardedRequestHeader(res, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
  });

  it.each([
    ['pv_live universal key', 'pv_live_deadbeef_' + 'b'.repeat(32)],
    ['legacy pv_cli key', 'pv_cli_deadbeef_' + 'c'.repeat(32)],
  ])('routes a Bearer %s to the machine path', async (_name, key) => {
    const res = await middleware(
      spoofedRequest('/api/v1/cost-sources', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
      }),
    );

    expect(forwardedRequestHeader(res, 'x-key-id')).toBe(AUTHORITATIVE_KEY_ID);
    expect(forwardedRequestHeader(res, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
  });

  it('routes a caller with neither auth header to the dashboard JWT path', async () => {
    const res = await middleware(spoofedRequest('/api/v1/cost-sources', { method: 'POST' }));

    expect(forwardedRequestHeader(res, 'x-user-id')).toBe('u-1');
    expect(forwardedRequestHeader(res, 'x-key-id')).toBeNull();
  });
});
