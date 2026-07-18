import { NextRequest, NextResponse } from 'next/server.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyCronSecret: vi.fn(),
  runBudgetCostEventProjection: vi.fn(),
  budgetProjectionRunFailedSystemically: vi.fn(),
  errorLog: vi.fn(),
}));

vi.mock('../../src/lib/cron/auth.js', () => ({ verifyCronSecret: mocks.verifyCronSecret }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ error: mocks.errorLog, info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../../src/lib/errors.js', () => ({
  authError: (_code: string, message: string) =>
    NextResponse.json({ error: message }, { status: 401 }),
  internalError: (message: string) => NextResponse.json({ error: message }, { status: 500 }),
}));
vi.mock('../../src/lib/budget-projection/worker.js', () => ({
  budgetProjectionRunFailedSystemically: mocks.budgetProjectionRunFailedSystemically,
  runBudgetCostEventProjection: mocks.runBudgetCostEventProjection,
}));

import { GET, POST } from '../../src/app/api/cron/project-budget-cost-events/route.js';

function request(method: 'GET' | 'POST' = 'POST'): NextRequest {
  return new NextRequest('https://pylva.test/api/cron/project-budget-cost-events', { method });
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    worker_incarnation: 'abcdef012345',
    scanned_builders: 1,
    errors: 0,
    recovered_leases: 0,
    claimed_events: 1,
    projected_events: 1,
    already_present_events: 0,
    lost_ack_recoveries: 0,
    retry_scheduled: 0,
    lease_lost: 0,
    projection_conflicts: 0,
    invalid_payloads: 0,
    reconciliation_scanned: 1,
    reconciliation_verified: 1,
    reconciliation_missing: 0,
    reconciliation_conflicts: 0,
    reconciliation_errors: 0,
    high_attempt_rows: 0,
    exhausted_attempt_rows: 0,
    pending_rows: 0,
    processing_rows: 0,
    projected_unverified_rows: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyCronSecret.mockReturnValue(true);
  mocks.budgetProjectionRunFailedSystemically.mockReturnValue(false);
  mocks.runBudgetCostEventProjection.mockResolvedValue(result());
});

describe('project-budget-cost-events cron route', () => {
  it('rejects unauthenticated invocations without touching the worker', async () => {
    mocks.verifyCronSecret.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.runBudgetCostEventProjection).not.toHaveBeenCalled();
  });

  it('returns observable counters without cacheable worker credentials', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ worker_incarnation: 'abcdef012345', projected_events: 1 });
    expect(JSON.stringify(body)).not.toContain('budget-projection:');
  });

  it.each([
    ['systemic failure', {}, true],
    ['high retry count', { high_attempt_rows: 1 }, false],
    ['attempt exhaustion', { exhausted_attempt_rows: 1 }, false],
    ['missing projection', { reconciliation_missing: 1 }, false],
    ['hash conflict', { reconciliation_conflicts: 1 }, false],
    ['reconciliation error', { reconciliation_errors: 1 }, false],
  ])('returns 5xx to trigger retry/alarm for %s', async (_label, overrides, systemic) => {
    mocks.runBudgetCostEventProjection.mockResolvedValue(result(overrides));
    mocks.budgetProjectionRunFailedSystemically.mockReturnValue(systemic);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.errorLog).toHaveBeenCalled();
  });

  it('sanitizes a worker crash and supports authenticated GET scheduling', async () => {
    mocks.runBudgetCostEventProjection.mockRejectedValueOnce(
      new Error('password=secret https://private.invalid'),
    );
    const failed = await POST(request());
    expect(failed.status).toBe(500);
    expect(JSON.stringify(mocks.errorLog.mock.calls)).not.toContain('password=secret');
    expect(JSON.stringify(mocks.errorLog.mock.calls)).not.toContain('private.invalid');

    mocks.runBudgetCostEventProjection.mockResolvedValueOnce(result());
    const succeeded = await GET(request('GET'));
    expect(succeeded.status).toBe(200);
  });
});
