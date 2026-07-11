// B2b T2-B — unit tests for /api/v1/customers/[id]/pricing.
//
// GET returns current + history (Member and Owner can read — no role gate).
// POST is Owner-only, validates the customer id + valibot pricing payload,
// checks the customer exists BEFORE reading the body, writes a new version
// via insertNewVersion, and audits `billing.pricing_set` when a user id is
// present. DB + versioning helpers are mocked; auth context, error helpers
// and the pricing validator are real (header-driven, like production).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const USER_ID = '00000000-0000-4000-8000-0000000000e1';

const mocks = vi.hoisted(() => ({
  withRole: vi.fn(),
  withRLS: vi.fn(),
  auditLog: vi.fn(),
  insertNewVersion: vi.fn(),
  getActiveVersion: vi.fn(),
  getAllVersions: vi.fn(),
  txSelect: vi.fn(),
}));

vi.mock('@/lib/auth/middleware', () => ({
  withRole: mocks.withRole,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('@/lib/billing/pricing-versioning', () => ({
  insertNewVersion: mocks.insertNewVersion,
  getActiveVersion: mocks.getActiveVersion,
  getAllVersions: mocks.getAllVersions,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: () => undefined, error: () => undefined }),
  },
}));

const { GET, POST } = await import('../../src/app/api/v1/customers/[id]/pricing/route.js');

const OWNER_HEADERS = {
  'x-builder-id': BUILDER_ID,
  'x-user-id': USER_ID,
  'x-user-role': 'owner',
};

const MEMBER_HEADERS = {
  'x-builder-id': BUILDER_ID,
  'x-user-id': USER_ID,
  'x-user-role': 'member',
};

function routeParams(id: string = CUSTOMER_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function getRequest(headers: Record<string, string> = OWNER_HEADERS): NextRequest {
  return new NextRequest(`http://localhost/api/v1/customers/${CUSTOMER_ID}/pricing`, { headers });
}

function postRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = OWNER_HEADERS,
): NextRequest {
  return postRawRequest(JSON.stringify(body), headers);
}

function postRawRequest(
  rawBody: string,
  headers: Record<string, string> = OWNER_HEADERS,
): NextRequest {
  return new NextRequest(`http://localhost/api/v1/customers/${CUSTOMER_ID}/pricing`, {
    method: 'POST',
    body: rawBody,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Rows returned by the resolveCustomerExists select inside withRLS.
let customerRows: Array<{ id: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  customerRows = [{ id: CUSTOMER_ID }];

  // Faithful reimplementation of src/lib/auth/middleware.ts withRole —
  // mocked because the real module drags in redis/config at import time.
  mocks.withRole.mockImplementation((allowed: string[], role: string | null) => {
    if (role === null) {
      return NextResponse.json(
        {
          error: {
            type: 'invalid_request_error',
            code: ErrorCode.INSUFFICIENT_PERMISSIONS,
            message: 'Role missing from session token',
          },
        },
        { status: 403 },
      );
    }
    if (!allowed.includes(role)) {
      return NextResponse.json(
        {
          error: {
            type: 'invalid_request_error',
            code: ErrorCode.INSUFFICIENT_PERMISSIONS,
            message: `Only ${allowed.join(', ')} can perform this action`,
          },
        },
        { status: 403 },
      );
    }
    return null;
  });

  mocks.withRLS.mockImplementation(async (_builderId: string, cb: (tx: unknown) => unknown) =>
    cb({ select: mocks.txSelect }),
  );
  mocks.txSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(customerRows),
      }),
    }),
  }));

  mocks.getActiveVersion.mockResolvedValue(null);
  mocks.getAllVersions.mockResolvedValue([]);
  mocks.insertNewVersion.mockResolvedValue({ id: 'version-row-2', version: 2 });
  mocks.auditLog.mockResolvedValue(undefined);
});

describe('GET /api/v1/customers/[id]/pricing', () => {
  it('returns the auth-context 500 when middleware did not set x-builder-id', async () => {
    const response = await GET(getRequest({}), routeParams());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: 'middleware did not set x-builder-id',
      },
    });
    expect(mocks.withRLS).not.toHaveBeenCalled();
    expect(mocks.getActiveVersion).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid customer id with 400 before touching the database', async () => {
    const response = await GET(getRequest(), routeParams('not-a-uuid'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid customer id',
        param: 'id',
      },
    });
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });

  it('returns 404 when the customer does not exist for this builder', async () => {
    customerRows = [];

    const response = await GET(getRequest(), routeParams());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: ErrorCode.NOT_FOUND,
        message: 'Customer not found',
      },
    });
    expect(mocks.getActiveVersion).not.toHaveBeenCalled();
    expect(mocks.getAllVersions).not.toHaveBeenCalled();
  });

  it('lets a Member read current + history — GET has no role gate', async () => {
    const current = {
      id: 'version-row-2',
      version: 2,
      pricing_model: 'flat',
      flat_rate_usd: '100.00',
      effective_to: null,
    };
    const history = [
      current,
      {
        id: 'version-row-1',
        version: 1,
        pricing_model: 'flat',
        flat_rate_usd: '50.00',
        effective_to: '2026-07-01T00:00:00.000Z',
      },
    ];
    mocks.getActiveVersion.mockResolvedValue(current);
    mocks.getAllVersions.mockResolvedValue(history);

    const response = await GET(getRequest(MEMBER_HEADERS), routeParams());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ current, history });
    expect(mocks.withRole).not.toHaveBeenCalled();
    expect(mocks.getActiveVersion).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      customerId: CUSTOMER_ID,
    });
    expect(mocks.getAllVersions).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      customerId: CUSTOMER_ID,
    });
  });

  it('serializes a customer with no pricing as current: null, history: []', async () => {
    const response = await GET(getRequest(), routeParams());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ current: null, history: [] });
  });
});

describe('POST /api/v1/customers/[id]/pricing', () => {
  it('returns the auth-context 500 when middleware did not set x-builder-id', async () => {
    const response = await POST(
      postRequest({ pricing_model: 'flat', flat_rate_usd: 100 }, {}),
      routeParams(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'middleware did not set x-builder-id' },
    });
    expect(mocks.withRole).not.toHaveBeenCalled();
    expect(mocks.insertNewVersion).not.toHaveBeenCalled();
  });

  it('rejects a Member with the withRole 403 before any DB access', async () => {
    const response = await POST(
      postRequest({ pricing_model: 'flat', flat_rate_usd: 100 }, MEMBER_HEADERS),
      routeParams(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        message: 'Only owner can perform this action',
      },
    });
    expect(mocks.withRole).toHaveBeenCalledWith(['owner'], 'member');
    expect(mocks.withRLS).not.toHaveBeenCalled();
    expect(mocks.insertNewVersion).not.toHaveBeenCalled();
  });

  it('rejects a caller with no x-user-role header (role null) with 403', async () => {
    const response = await POST(
      postRequest(
        { pricing_model: 'flat', flat_rate_usd: 100 },
        { 'x-builder-id': BUILDER_ID, 'x-user-id': USER_ID },
      ),
      routeParams(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        message: 'Role missing from session token',
      },
    });
    expect(mocks.withRole).toHaveBeenCalledWith(['owner'], null);
    expect(mocks.insertNewVersion).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid customer id with 400', async () => {
    const response = await POST(
      postRequest({ pricing_model: 'flat', flat_rate_usd: 100 }),
      routeParams('customer-external-id'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid customer id', param: 'id' },
    });
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown customer before parsing the body', async () => {
    customerRows = [];

    // Body is deliberately malformed JSON: the existence check runs first,
    // so an unknown customer yields 404, not the 400 JSON error.
    const response = await POST(postRawRequest('{not json'), routeParams());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.NOT_FOUND, message: 'Customer not found' },
    });
    expect(mocks.insertNewVersion).not.toHaveBeenCalled();
  });

  it('rejects a malformed JSON body with 400 once the customer exists', async () => {
    const response = await POST(postRawRequest('{not json'), routeParams());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid JSON body', param: 'body' },
    });
    expect(mocks.insertNewVersion).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown pricing_model', { pricing_model: 'freemium' }, 'pricing_model'],
    ['missing flat_rate_usd', { pricing_model: 'flat' }, 'flat_rate_usd'],
    ['negative flat_rate_usd', { pricing_model: 'flat', flat_rate_usd: -5 }, 'flat_rate_usd'],
    [
      'empty per_unit_rates',
      { pricing_model: 'pay_as_you_go', per_unit_rates: {} },
      'per_unit_rates',
    ],
    [
      'invalid billing_period',
      { pricing_model: 'flat', flat_rate_usd: 10, billing_period: 'yearly' },
      'billing_period',
    ],
  ])('rejects %s with 400 and the offending param', async (_label, body, expectedParam) => {
    const response = await POST(postRequest(body), routeParams());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: expectedParam },
    });
    expect(mocks.insertNewVersion).not.toHaveBeenCalled();
  });

  it('falls back to param "body" when the payload is not an object', async () => {
    const response = await POST(postRawRequest('"flat"'), routeParams());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: 'body' },
    });
    expect(mocks.insertNewVersion).not.toHaveBeenCalled();
  });

  it('writes a new version for an Owner and audits billing.pricing_set', async () => {
    const response = await POST(
      postRequest({ pricing_model: 'flat', flat_rate_usd: 100 }),
      routeParams(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toStrictEqual({ id: 'version-row-2', version: 2 });
    // billing_period defaults to 'monthly' via the valibot schema.
    expect(mocks.insertNewVersion).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      customerId: CUSTOMER_ID,
      input: { pricing_model: 'flat', billing_period: 'monthly', flat_rate_usd: 100 },
    });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const [, auditEntry] = mocks.auditLog.mock.calls[0]!;
    expect(auditEntry).toStrictEqual({
      builder_id: BUILDER_ID,
      actor_type: 'user',
      actor_id: USER_ID,
      action: 'billing.pricing_set',
      resource_type: 'customer_pricing',
      resource_id: 'version-row-2',
      details: { customer_id: CUSTOMER_ID, version: 2, pricing_model: 'flat' },
    });
  });

  it('skips the audit write when the context carries no user id', async () => {
    const response = await POST(
      postRequest(
        { pricing_model: 'flat', flat_rate_usd: 100 },
        { 'x-builder-id': BUILDER_ID, 'x-user-role': 'owner' },
      ),
      routeParams(),
    );

    expect(response.status).toBe(201);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    // withRLS ran only for the existence check, not a second audit transaction.
    expect(mocks.withRLS).toHaveBeenCalledTimes(1);
  });

  it('maps an insertNewVersion failure to a 500 internal error', async () => {
    mocks.insertNewVersion.mockRejectedValueOnce(new Error('unique violation'));

    const response = await POST(
      postRequest({ pricing_model: 'flat', flat_rate_usd: 100 }),
      routeParams(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Failed to update pricing',
      },
    });
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });
});
