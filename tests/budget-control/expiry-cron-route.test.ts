import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  CRON_SECRET: 'test-secret-min-32-chars-aaaaaaaaaaa' as string | undefined,
  // Deliberately present so the maintenance-independence test documents that
  // this reserve-only rollout switch is not consulted by the route.
  ENABLE_AUTHORITATIVE_BUDGET_CONTROL: false,
}));
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({ env: envState }));
vi.mock('../../src/lib/budget-control/expiry-runner.js', () => ({
  runBudgetReservationExpiry: mocks.run,
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ error: mocks.error, info: mocks.info }) },
}));

const route = await import('../../src/app/api/cron/expire-budget-reservations/route.js');

function request(
  authorization?: string,
  method: 'GET' | 'POST' = 'POST',
): import('next/server.js').NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('http://localhost/api/cron/expire-budget-reservations', {
    method,
    headers,
  }) as unknown as import('next/server.js').NextRequest;
}

const validAuthorization = `Bearer ${envState.CRON_SECRET}`;

describe('authoritative budget reservation expiry cron route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.CRON_SECRET = 'test-secret-min-32-chars-aaaaaaaaaaa';
    envState.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = false;
    mocks.run.mockResolvedValue({
      scanned_builders: 2,
      expired_reservations: 3,
      errors: 0,
    });
  });

  it.each([undefined, '', 'Bearer wrong-secret', 'Basic credentials'])(
    'returns a non-cacheable 401 for invalid authorization %s',
    async (authorization) => {
      const response = await route.POST(request(authorization));

      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect((await response.json()).error).toMatchObject({ code: 'INVALID_API_KEY' });
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );

  it('fails closed with a non-cacheable 401 when CRON_SECRET is unset', async () => {
    envState.CRON_SECRET = undefined;

    const response = await route.POST(request('Bearer anything'));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('runs authenticated maintenance even when new authoritative reservations are disabled', async () => {
    envState.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = false;

    const response = await route.POST(request(validAuthorization));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      scanned_builders: 2,
      expired_reservations: 3,
      errors: 0,
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('supports the scheduler GET verb with identical authentication and behavior', async () => {
    const response = await route.GET(request(validAuthorization, 'GET'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('keeps a partial builder failure successful so healthy tenants still make progress', async () => {
    mocks.run.mockResolvedValueOnce({
      scanned_builders: 4,
      expired_reservations: 7,
      errors: 1,
    });

    const response = await route.POST(request(validAuthorization));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      scanned_builders: 4,
      expired_reservations: 7,
      errors: 1,
    });
  });

  it('returns a non-cacheable 500 when every scanned builder failed', async () => {
    mocks.run.mockResolvedValueOnce({
      scanned_builders: 4,
      expired_reservations: 0,
      errors: 4,
    });

    const response = await route.POST(request(validAuthorization));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(mocks.error).toHaveBeenCalledWith(
      { scanned_builders: 4, expired_reservations: 0, errors: 4 },
      'budget reservation expiry failed for all scanned builders',
    );
  });

  it('sanitizes an unexpected runner failure in both logs and the response', async () => {
    const secretMessage = 'postgresql://operator:secret@database/private-tenant';
    mocks.run.mockRejectedValueOnce(new TypeError(secretMessage));

    const response = await route.POST(request(validAuthorization));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'budget reservation expiry cron crashed',
    });
    expect(JSON.stringify(body)).not.toContain(secretMessage);
    expect(mocks.error).toHaveBeenCalledWith(
      { error_type: 'TypeError' },
      'budget reservation expiry cron crashed',
    );
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(secretMessage);
  });

  it('declares an uncached Node runtime for database lifecycle work', () => {
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});
