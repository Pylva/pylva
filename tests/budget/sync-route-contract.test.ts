// B2a T3 — contract tests for POST /api/v1/budget/sync.
//
// SDK-facing reconciliation endpoint. Middleware injects x-builder-id +
// x-key-id; readBuilderContext (real, header-driven here) 500s if either is
// missing. Body is { entries: [...] } capped at 500 entries; every
// validation failure reports param 'body'. The route hands the parsed
// entries to reconcileBudgetSync(builderId, entries) — mocked — and wraps
// the result as { entries: [...] } (same key in and out, not `results`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const KEY_ID = 'key_0123456789ab';
const RULE_ID = '00000000-0000-4000-8000-0000000000aa';

const mocks = vi.hoisted(() => ({
  reconcileBudgetSync: vi.fn(),
}));

vi.mock('@/lib/budget/sync-handler', () => ({
  reconcileBudgetSync: mocks.reconcileBudgetSync,
}));

const { POST } = await import('../../src/app/api/v1/budget/sync/route.js');

const SDK_HEADERS = {
  'x-builder-id': BUILDER_ID,
  'x-key-id': KEY_ID,
};

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rule_id: RULE_ID,
    scope: 'per_customer',
    customer_id: 'cust_1',
    accumulated_cost_usd: 1.25,
    period_start: '2026-07-01T00:00:00.000Z',
    event_count: 3,
    ...overrides,
  };
}

function syncRequest(rawBody: string, headers: Record<string, string> = SDK_HEADERS): NextRequest {
  return new NextRequest('http://localhost/api/v1/budget/sync', {
    method: 'POST',
    body: rawBody,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function syncJsonRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = SDK_HEADERS,
): NextRequest {
  return syncRequest(JSON.stringify(body), headers);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reconcileBudgetSync.mockResolvedValue([]);
});

describe('POST /api/v1/budget/sync auth guard', () => {
  it('returns the middleware-guard 500 when both auth headers are missing', async () => {
    const response = await POST(syncJsonRequest({ entries: [makeEntry()] }, {}));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: 'middleware did not set x-builder-id / x-key-id',
      },
    });
    expect(mocks.reconcileBudgetSync).not.toHaveBeenCalled();
  });

  it('returns 500 when x-builder-id is present but x-key-id is missing', async () => {
    const response = await POST(
      syncJsonRequest({ entries: [makeEntry()] }, { 'x-builder-id': BUILDER_ID }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.INTERNAL_ERROR },
    });
    expect(mocks.reconcileBudgetSync).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/budget/sync body validation', () => {
  it('rejects a malformed JSON body with 400', async () => {
    const response = await POST(syncRequest('{not json'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid JSON body',
        param: 'body',
      },
    });
    expect(mocks.reconcileBudgetSync).not.toHaveBeenCalled();
  });

  it.each([
    ['missing entries key', {}],
    ['entries not an array', { entries: 'not-an-array' }],
    ['non-uuid rule_id', { entries: [makeEntry({ rule_id: 'rule-1' })] }],
    ['unknown scope', { entries: [makeEntry({ scope: 'global' })] }],
    ['missing customer_id key', { entries: [{ ...makeEntry(), customer_id: undefined }] }],
    ['negative accumulated_cost_usd', { entries: [makeEntry({ accumulated_cost_usd: -0.01 })] }],
    ['non-integer event_count', { entries: [makeEntry({ event_count: 1.5 })] }],
    ['non-string period_start', { entries: [makeEntry({ period_start: 1751328000000 })] }],
  ])('rejects %s with 400 and param body', async (_label, body) => {
    const response = await POST(syncJsonRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: 'body' },
    });
    expect(mocks.reconcileBudgetSync).not.toHaveBeenCalled();
  });

  it('rejects more than 500 entries with 400', async () => {
    const entries = Array.from({ length: 501 }, () => makeEntry());

    const response = await POST(syncJsonRequest({ entries }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; param: string } };
    expect(body.error.param).toBe('body');
    expect(body.error.message).toContain('500');
    expect(mocks.reconcileBudgetSync).not.toHaveBeenCalled();
  });

  it('accepts exactly 500 entries (cap is inclusive)', async () => {
    const entries = Array.from({ length: 500 }, () => makeEntry());

    const response = await POST(syncJsonRequest({ entries }));

    expect(response.status).toBe(200);
    expect(mocks.reconcileBudgetSync).toHaveBeenCalledTimes(1);
    const [builderId, forwarded] = mocks.reconcileBudgetSync.mock.calls[0]!;
    expect(builderId).toBe(BUILDER_ID);
    expect(forwarded).toHaveLength(500);
  });

  it('accepts an empty entries array and reconciles nothing', async () => {
    const response = await POST(syncJsonRequest({ entries: [] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ entries: [] });
    expect(mocks.reconcileBudgetSync).toHaveBeenCalledWith(BUILDER_ID, []);
  });
});

describe('POST /api/v1/budget/sync reconciliation contract', () => {
  it('forwards (builderId, parsed entries) and returns the handler result as { entries }', async () => {
    const reconciled = [
      {
        rule_id: RULE_ID,
        scope: 'per_customer',
        customer_id: 'cust_1',
        period_start: '2026-07-01T00:00:00.000Z',
        server_total_usd: 4.2,
        budget_remaining_usd: 5.8,
        budget_exceeded: false,
        reconciled_at: '2026-07-09T12:00:00.000Z',
      },
      {
        rule_id: RULE_ID,
        scope: 'pooled',
        customer_id: null,
        period_start: '2026-07-01T00:00:00.000Z',
        server_total_usd: 10,
        budget_remaining_usd: 0,
        budget_exceeded: true,
        reconciled_at: '2026-07-09T12:00:00.000Z',
      },
    ];
    mocks.reconcileBudgetSync.mockResolvedValueOnce(reconciled);

    const perCustomerEntry = makeEntry({ extra_field: 'stripped-by-valibot' });
    const pooledEntry = makeEntry({
      scope: 'pooled',
      customer_id: null,
      accumulated_cost_usd: 0,
      event_count: 0,
    });

    const response = await POST(syncJsonRequest({ entries: [perCustomerEntry, pooledEntry] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ entries: reconciled });
    expect(mocks.reconcileBudgetSync).toHaveBeenCalledTimes(1);
    // Valibot strips unknown keys: the handler sees only the schema fields.
    expect(mocks.reconcileBudgetSync).toHaveBeenCalledWith(BUILDER_ID, [
      {
        rule_id: RULE_ID,
        scope: 'per_customer',
        customer_id: 'cust_1',
        accumulated_cost_usd: 1.25,
        period_start: '2026-07-01T00:00:00.000Z',
        event_count: 3,
      },
      {
        rule_id: RULE_ID,
        scope: 'pooled',
        customer_id: null,
        accumulated_cost_usd: 0,
        period_start: '2026-07-01T00:00:00.000Z',
        event_count: 0,
      },
    ]);
  });
});
