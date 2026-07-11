import { describe, expect, it, vi } from 'vitest';

const envState = {
  CRON_SECRET: 'test-secret-min-32-chars-aaaaaaaaaaa',
  NODE_ENV: 'test',
};

vi.mock('../../src/lib/config.js', () => ({ env: envState }));

const { POST } = await import('../../src/app/api/cron/sentry-smoke/route.js');

function makeRequest(authorization?: string, body?: unknown): import('next/server.js').NextRequest {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request('http://localhost/api/cron/sentry-smoke', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import('next/server.js').NextRequest;
}

describe('POST /api/cron/sentry-smoke', () => {
  it('rejects requests without a bearer token', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
  });

  it('rejects requests with the wrong bearer token', async () => {
    const response = await POST(makeRequest('Bearer wrong-token'));
    expect(response.status).toBe(401);
  });

  it('throws a controlled sanitized marker after cron auth succeeds', async () => {
    await expect(
      POST(
        makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa', {
          marker: 'prod smoke 2026/06/11 #1',
        }),
      ),
    ).rejects.toThrow('[sentry-smoke] prod_smoke_2026_06_11__1');
  });
});
