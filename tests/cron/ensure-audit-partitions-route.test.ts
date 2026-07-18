// Route-level coverage for the audit_log partition manager counters.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestPartitionSpec {
  name: string;
  from: string;
  to: string;
}

const PARTITION_SPECS: TestPartitionSpec[] = [
  {
    name: 'audit_log_y2026m07',
    from: '2026-07-01',
    to: '2026-08-01',
  },
  {
    name: 'audit_log_y2026m08',
    from: '2026-08-01',
    to: '2026-09-01',
  },
];

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  auditLogPartitionSpecs: vi.fn(),
  isValidPartitionSpec: vi.fn(),
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

vi.mock('@/lib/db/audit-partitions', () => ({
  auditLogPartitionSpecs: mocks.auditLogPartitionSpecs,
  isValidPartitionSpec: mocks.isValidPartitionSpec,
}));

const { GET, POST } = await import('../../src/app/api/cron/ensure-audit-partitions/route.js');

function makeRequest(authorization?: string): import('next/server.js').NextRequest {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/ensure-audit-partitions', {
    method: 'POST',
    headers,
  }) as unknown as import('next/server.js').NextRequest;
}

async function authorizedPost(): Promise<Response> {
  return POST(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
}

function expectNoStore(response: Response): void {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
}

describe('POST /api/cron/ensure-audit-partitions', () => {
  beforeEach(() => {
    mocks.dbExecute.mockReset();
    mocks.info.mockReset();
    mocks.warn.mockReset();
    mocks.error.mockReset();
    mocks.auditLogPartitionSpecs.mockReset();
    mocks.isValidPartitionSpec.mockReset();
    mocks.env.CRON_SECRET = 'test-secret-min-32-chars-aaaaaaaaaaa';
    mocks.auditLogPartitionSpecs.mockReturnValue(PARTITION_SPECS);
    mocks.isValidPartitionSpec.mockImplementation(
      (spec: TestPartitionSpec) => spec.name !== 'invalid_partition',
    );
  });

  it('rejects requests without a bearer token', async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong bearer token', async () => {
    const response = await POST(makeRequest('Bearer wrong-token'));

    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  it('marks an unauthorized GET response as no-store', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  it('counts absent partitions as created on a fresh run', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ created: true }])
      .mockResolvedValueOnce([{ created: true }]);

    const response = await authorizedPost();
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(body).toEqual({
      requested: 2,
      ensured: 2,
      created: 2,
      existing: 0,
      failed: 0,
      invalid: 0,
    });
  });

  it('counts steady-state partitions as existing without issuing create DDL', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ created: false }])
      .mockResolvedValueOnce([{ created: false }]);

    const response = await authorizedPost();
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(body).toEqual({
      requested: 2,
      ensured: 2,
      created: 0,
      existing: 2,
      failed: 0,
      invalid: 0,
    });
  });

  it('reports 500 when a partition create fails so EventBridge retries', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ created: true }])
      .mockRejectedValueOnce(new Error('boom'));

    const response = await authorizedPost();
    const body = (await response.json()) as {
      error?: { message?: string };
    };

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(body.error?.message).toContain('ensured 1 of 2');
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      {
        requested: 2,
        ensured: 1,
        created: 1,
        existing: 0,
        failed: 1,
        invalid: 0,
      },
      'ensure-audit-partitions left partitions missing',
    );
  });

  it('treats a serialized existing result as an existing partition', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ created: false }])
      .mockResolvedValueOnce([{ created: true }]);

    const response = await authorizedPost();
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toEqual({
      requested: 2,
      ensured: 2,
      created: 1,
      existing: 1,
      failed: 0,
      invalid: 0,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('counts malformed specs as invalid and never issues create DDL', async () => {
    mocks.auditLogPartitionSpecs.mockReturnValue([
      {
        name: 'invalid_partition',
        from: '2026-07-01',
        to: '2026-08-01',
      },
    ]);
    const response = await authorizedPost();
    const body = (await response.json()) as {
      error?: { message?: string };
    };

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(body.error?.message).toContain('ensured 0 of 1');
    expect(mocks.error).toHaveBeenCalledWith(
      { partition: 'invalid_partition' },
      'refusing malformed audit_log partition spec',
    );
  });

  it('marks an unexpected internal crash as no-store', async () => {
    mocks.auditLogPartitionSpecs.mockImplementationOnce(() => {
      throw new Error('unexpected crash');
    });

    const response = await authorizedPost();
    const body = (await response.json()) as {
      error?: { message?: string };
    };

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(body.error?.message).toBe('ensure-audit-partitions crashed');
    expect(mocks.dbExecute).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      { error: 'unexpected crash' },
      'ensure-audit-partitions crashed',
    );
  });

  it('marks GET success responses as no-store without changing the route result', async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ created: true }])
      .mockResolvedValueOnce([{ created: false }]);

    const response = await GET(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toEqual({
      requested: 2,
      ensured: 2,
      created: 1,
      existing: 1,
      failed: 0,
      invalid: 0,
    });
  });
});
