// Regression coverage for /api/cron/purge-audit-log.
//
// porsager/postgres returns a Result that `extends Array` (rows are the array
// elements) — it has NO `.rows` property. The route previously read
// `(partitions).rows`, which is `undefined`, so `for (const r of rows)` threw
// and the cron 500'd on EVERY run: no expired audit_log partition was ever
// dropped and the table grew unbounded. These tests mock `db.execute` with the
// REAL array shape (matching the live adapter and the rest of the suite) so the
// bug reproduces without a database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  env: {
    CRON_SECRET: 'test-secret-min-32-chars-aaaaaaaaaaa',
    NODE_ENV: 'test',
  },
}));

vi.mock('@/lib/config', () => ({ env: mocks.env }));

vi.mock('@/lib/db/client', () => ({
  db: { execute: mocks.dbExecute },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.info,
      warn: mocks.warn,
      error: mocks.error,
    }),
  },
}));

const { POST } = await import('../../src/app/api/cron/purge-audit-log/route.js');

function makeRequest(authorization?: string): import('next/server.js').NextRequest {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/purge-audit-log', {
    method: 'POST',
    headers,
  }) as unknown as import('next/server.js').NextRequest;
}

async function authorizedPost(): Promise<Response> {
  return POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
}

describe('POST /api/cron/purge-audit-log', () => {
  beforeEach(() => {
    mocks.dbExecute.mockReset();
    mocks.info.mockReset();
    mocks.warn.mockReset();
    mocks.error.mockReset();
    mocks.env.CRON_SECRET = 'test-secret-min-32-chars-aaaaaaaaaaa';
  });

  it('rejects requests without a bearer token', async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  it('drops partitions older than the retention window and keeps recent ones', async () => {
    // Array shape — exactly what postgres-js / drizzle return at runtime.
    // y2020m01 is far older than the 365-day cutoff (drop); y2099m01 is in the
    // future (keep). Anchored well outside the window so the test stays correct
    // regardless of the current date.
    mocks.dbExecute
      .mockResolvedValueOnce([
        { partition_name: 'audit_log_y2020m01' },
        { partition_name: 'audit_log_y2099m01' },
      ])
      .mockResolvedValue([]); // the DROP TABLE statement

    const response = await authorizedPost();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ dropped: 1, retention_days: 365 });
    // 1 SELECT + exactly 1 DROP (only the expired partition).
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
  });

  it('is a no-op (dropped: 0) when nothing has aged out', async () => {
    mocks.dbExecute.mockResolvedValueOnce([
      { partition_name: 'audit_log_y2099m01' },
      { partition_name: 'audit_log_y2099m02' },
    ]);

    const response = await authorizedPost();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ dropped: 0, retention_days: 365 });
    // Only the SELECT runs; no DROP is issued.
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
  });
});
