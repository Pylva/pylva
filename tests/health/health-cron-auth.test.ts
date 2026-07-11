// CRON_SECRET guard + ENABLE_COST_SOURCES kill switch on the health-check
// cron route.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = {
  ENABLE_COST_SOURCES: true,
  CRON_SECRET: 'test-secret-min-32-chars-aaaaaaaaaaa',
  NODE_ENV: 'test',
};

vi.mock('../../src/lib/config.js', () => ({
  env: envState,
}));

const runHealthCheckMock = vi.fn(async () => ({
  scanned_builders: 0,
  scanned_sources: 0,
  silence_alerts: 0,
  cost_drop_alerts: 0,
  cold_start: 0,
  status_changes: 0,
  errors: 0,
}));

vi.mock('../../src/lib/health/runner.js', () => ({
  runHealthCheck: runHealthCheckMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  },
}));

const { POST } = await import('../../src/app/api/cron/health-check/route.js');

function makeRequest(authorization?: string): import('next/server.js').NextRequest {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/health-check', {
    method: 'POST',
    headers,
  }) as unknown as import('next/server.js').NextRequest;
}

describe('POST /api/cron/health-check', () => {
  beforeEach(() => {
    runHealthCheckMock.mockClear();
    envState.ENABLE_COST_SOURCES = true;
    envState.CRON_SECRET = 'test-secret-min-32-chars-aaaaaaaaaaa';
  });

  it('rejects requests without a bearer token (401)', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
    expect(runHealthCheckMock).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong bearer token (401)', async () => {
    const response = await POST(makeRequest('Bearer wrong-token'));
    expect(response.status).toBe(401);
    expect(runHealthCheckMock).not.toHaveBeenCalled();
  });

  it('returns 503 when ENABLE_COST_SOURCES kill switch is off', async () => {
    envState.ENABLE_COST_SOURCES = false;
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('FEATURE_NOT_AVAILABLE');
    expect(runHealthCheckMock).not.toHaveBeenCalled();
  });

  it('runs the health check when bearer + kill switch align', async () => {
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(200);
    expect(runHealthCheckMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when every scanned builder failed (systemic outage, e.g. ClickHouse down)', async () => {
    // Promise.allSettled inside runHealthCheck swallows per-builder rejections
    // into `errors`. A total outage makes errors === scanned_builders; the
    // route must surface that as a failure so EventBridge retries + alarms,
    // instead of recording a silent success that hides the outage.
    runHealthCheckMock.mockResolvedValueOnce({
      scanned_builders: 4,
      scanned_sources: 0,
      silence_alerts: 0,
      cost_drop_alerts: 0,
      cold_start: 0,
      status_changes: 0,
      errors: 4,
    });
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(500);
  });

  it('still returns 200 on a partial failure (per-builder isolation preserved)', async () => {
    runHealthCheckMock.mockResolvedValueOnce({
      scanned_builders: 4,
      scanned_sources: 6,
      silence_alerts: 1,
      cost_drop_alerts: 0,
      cold_start: 0,
      status_changes: 1,
      errors: 1,
    });
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(200);
  });

  it('returns 401 when CRON_SECRET is unset (defensive)', async () => {
    envState.CRON_SECRET = '';
    const response = await POST(makeRequest('Bearer anything'));
    expect(response.status).toBe(401);
  });
});
