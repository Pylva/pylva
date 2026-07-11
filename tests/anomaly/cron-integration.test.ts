// B4-4b — Cron route auth + kill-switch. Mirrors tests/health/health-cron-auth.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = {
  ENABLE_ADVANCED_RULES: true,
  CRON_SECRET: 'test-secret-min-32-chars-aaaaaaaaaaa',
  NODE_ENV: 'test',
};

vi.mock('../../src/lib/config.js', () => ({ env: envState }));

const detectAnomaliesMock = vi.fn(async () => ({
  scanned_builders: 0,
  cold_start_skipped: 0,
  anomalies_inserted: 0,
  anomalies_skipped_idempotent: 0,
  errors: 0,
}));

vi.mock('../../src/lib/anomaly/runner.js', () => ({
  detectAnomalies: detectAnomaliesMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

const { POST } = await import('../../src/app/api/cron/detect-anomalies/route.js');

function makeRequest(authorization?: string): import('next/server.js').NextRequest {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/detect-anomalies', {
    method: 'POST',
    headers,
  }) as unknown as import('next/server.js').NextRequest;
}

describe('POST /api/cron/detect-anomalies', () => {
  beforeEach(() => {
    detectAnomaliesMock.mockClear();
    envState.ENABLE_ADVANCED_RULES = true;
    envState.CRON_SECRET = 'test-secret-min-32-chars-aaaaaaaaaaa';
  });

  it('rejects requests without a bearer token', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
    expect(detectAnomaliesMock).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong bearer token', async () => {
    const response = await POST(makeRequest('Bearer wrong'));
    expect(response.status).toBe(401);
  });

  it('returns 503 when ENABLE_ADVANCED_RULES is off', async () => {
    envState.ENABLE_ADVANCED_RULES = false;
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('FEATURE_NOT_AVAILABLE');
    expect(detectAnomaliesMock).not.toHaveBeenCalled();
  });

  it('runs the detector when bearer + kill switch align', async () => {
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(200);
    expect(detectAnomaliesMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when every scanned builder failed (systemic outage)', async () => {
    // detectAnomalies folds per-builder rejections into `errors`; a total
    // outage (errors === scanned_builders) must surface as 500 so EventBridge
    // retries + alarms rather than silently recording success.
    detectAnomaliesMock.mockResolvedValueOnce({
      scanned_builders: 3,
      cold_start_skipped: 0,
      anomalies_inserted: 0,
      anomalies_skipped_idempotent: 0,
      errors: 3,
    });
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(500);
  });

  it('still returns 200 on a partial failure', async () => {
    detectAnomaliesMock.mockResolvedValueOnce({
      scanned_builders: 3,
      cold_start_skipped: 1,
      anomalies_inserted: 2,
      anomalies_skipped_idempotent: 0,
      errors: 1,
    });
    const response = await POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    expect(response.status).toBe(200);
  });
});
