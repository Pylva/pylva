import { beforeEach, describe, expect, it, vi } from 'vitest';

const AUTHORITATIVE_BUILDER = '11111111-1111-1111-1111-111111111111';
const SPOOFED_BUILDER = '22222222-2222-2222-2222-222222222222';
const AUTHORITATIVE_KEY_ID = 'control0';
const CONTROL_LIMIT = { maxRequests: 600, windowMs: 60_000 };

const authMocks = vi.hoisted(() => ({
  withApiKeyAuth: vi.fn(),
  withJwtAuth: vi.fn(),
  withRateLimit: vi.fn(),
  withMembership: vi.fn(),
  requestHasActiveSession: vi.fn(),
  setDashboardSessionCookies: vi.fn(),
}));

vi.mock('../../src/lib/auth/middleware.js', () => ({
  ...authMocks,
  RATE_LIMIT_PRESETS: {
    telemetry: { maxRequests: 1000, windowMs: 60_000 },
    budgetControl: { maxRequests: 600, windowMs: 60_000 },
    controlPlane: { maxRequests: 100, windowMs: 60_000 },
    dashboardRead: { maxRequests: 120, windowMs: 60_000 },
    dashboardWrite: { maxRequests: 30, windowMs: 60_000 },
  },
}));

vi.mock('../../src/lib/config.js', () => ({
  env: {
    OAUTH_REDIRECT_BASE_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../../src/lib/auth/jwt.js', () => ({ signJwt: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn() }) },
}));

const { NextRequest, NextResponse } = await import('next/server.js');
const { middleware } = await import('../../src/middleware.js');

const RESERVATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTROL_PATHS = [
  ['capabilities', '/api/v1/budget/capabilities', 'GET'],
  ['reserve', '/api/v1/budget/reservations', 'POST'],
  ['commit', `/api/v1/budget/reservations/${RESERVATION_ID}/commit`, 'POST'],
  ['release', `/api/v1/budget/reservations/${RESERVATION_ID}/release`, 'POST'],
  ['extend', `/api/v1/budget/reservations/${RESERVATION_ID}/extend`, 'POST'],
] as const;

function controlRequest(pathname: string, method = 'POST') {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: {
      'X-Pylva-Key': `pv_live_deadbeef_${'a'.repeat(32)}`,
      'x-builder-id': SPOOFED_BUILDER,
      'x-key-id': 'spoofed-key',
      'x-user-id': 'spoofed-user',
      'x-user-role': 'owner',
      cookie: 'pylva_session=dashboard-token-must-not-be-used',
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function forwardedRequestHeader(response: { headers: Headers }, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe('authoritative budget-control middleware boundary', () => {
  beforeEach(() => {
    for (const mock of Object.values(authMocks)) mock.mockReset();
    authMocks.withApiKeyAuth.mockResolvedValue({
      builderId: AUTHORITATIVE_BUILDER,
      scope: 'universal',
      keyId: AUTHORITATIVE_KEY_ID,
    });
    authMocks.withRateLimit.mockResolvedValue(null);
  });

  it.each(CONTROL_PATHS)(
    'routes the %s path through SDK API-key auth and strips spoofed identity',
    async (_name, pathname, method) => {
      const response = await middleware(controlRequest(pathname, method));

      expect(authMocks.withApiKeyAuth).toHaveBeenCalledTimes(1);
      expect(authMocks.withJwtAuth).not.toHaveBeenCalled();
      expect(authMocks.withMembership).not.toHaveBeenCalled();
      expect(authMocks.withRateLimit).toHaveBeenCalledWith(
        `budget_control:${AUTHORITATIVE_KEY_ID}`,
        CONTROL_LIMIT,
      );
      expect(forwardedRequestHeader(response, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
      expect(forwardedRequestHeader(response, 'x-builder-id')).not.toBe(SPOOFED_BUILDER);
      expect(forwardedRequestHeader(response, 'x-key-id')).toBe(AUTHORITATIVE_KEY_ID);
      expect(forwardedRequestHeader(response, 'x-user-id')).toBeNull();
      expect(forwardedRequestHeader(response, 'x-user-role')).toBeNull();
      expect(forwardedRequestHeader(response, 'x-pathname')).toBe(pathname);
      expect(response.headers.get('x-builder-id')).toBeNull();
      expect(response.headers.get('x-key-id')).toBeNull();
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it.each(['commit', 'release', 'extend'] as const)(
    'matches the dynamic reservation-id /%s route without using ID contents as authority',
    async (action) => {
      const opaqueId = 'client-opaque.id:with-safe-route-chars';
      const pathname = `/api/v1/budget/reservations/${opaqueId}/${action}`;

      const response = await middleware(controlRequest(`${pathname}?ignored=spoof`, 'POST'));

      expect(authMocks.withApiKeyAuth).toHaveBeenCalledTimes(1);
      expect(authMocks.withJwtAuth).not.toHaveBeenCalled();
      expect(forwardedRequestHeader(response, 'x-builder-id')).toBe(AUTHORITATIVE_BUILDER);
      expect(forwardedRequestHeader(response, 'x-pathname')).toBe(pathname);
    },
  );

  it.each([
    `/api/v1/budget/reservations/${RESERVATION_ID}/unknown-transition`,
    `/api/v1/budget/reservations/${RESERVATION_ID}/commit/extra`,
    '/api/v1/budget/capabilities/future-version',
  ])('does not let a malformed or future control child %s downgrade to JWT auth', async (path) => {
    await middleware(controlRequest(path, 'POST'));

    expect(authMocks.withApiKeyAuth).toHaveBeenCalledTimes(1);
    expect(authMocks.withJwtAuth).not.toHaveBeenCalled();
  });

  it('keeps auth dispatch machine-only even when a control path uses the wrong method', async () => {
    await middleware(controlRequest(`/api/v1/budget/reservations/${RESERVATION_ID}/commit`, 'GET'));

    expect(authMocks.withApiKeyAuth).toHaveBeenCalledTimes(1);
    expect(authMocks.withJwtAuth).not.toHaveBeenCalled();
  });

  it('returns an API-key authentication failure without trying dashboard JWT fallback', async () => {
    const apiKeyFailure = NextResponse.json(
      { error: { message: 'Missing API key' } },
      { status: 401 },
    );
    authMocks.withApiKeyAuth.mockResolvedValue(apiKeyFailure);

    const response = await middleware(controlRequest('/api/v1/budget/capabilities', 'GET'));

    expect(response).toBe(apiKeyFailure);
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(authMocks.withRateLimit).not.toHaveBeenCalled();
    expect(authMocks.withJwtAuth).not.toHaveBeenCalled();
  });

  it('returns the dedicated control-bucket throttle without JWT fallback', async () => {
    const throttle = NextResponse.json(
      { error: { message: 'Too many control requests' } },
      {
        status: 429,
      },
    );
    authMocks.withRateLimit.mockResolvedValue(throttle);

    const response = await middleware(controlRequest('/api/v1/budget/reservations', 'POST'));

    expect(response).toBe(throttle);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(authMocks.withRateLimit).toHaveBeenCalledWith(
      `budget_control:${AUTHORITATIVE_KEY_ID}`,
      CONTROL_LIMIT,
    );
    expect(authMocks.withJwtAuth).not.toHaveBeenCalled();
  });

  it('keeps legacy budget sync in its existing telemetry bucket', async () => {
    await middleware(controlRequest('/api/v1/budget/sync', 'POST'));

    expect(authMocks.withApiKeyAuth).toHaveBeenCalledTimes(1);
    expect(authMocks.withRateLimit).toHaveBeenCalledWith(`agent_sdk:${AUTHORITATIVE_KEY_ID}`, {
      maxRequests: 1000,
      windowMs: 60_000,
    });
    expect(authMocks.withJwtAuth).not.toHaveBeenCalled();
  });
});
