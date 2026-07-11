// B2b T2-B / I-T2-12 — unit tests for POST /api/v1/customers/[id]/pricing/undo-last.
//
// Owner-only. Delegates to undoLastVersion with the 10s UNDO_WINDOW_SECONDS;
// a null result (expired window OR nothing to undo) maps to 410 gone with
// code NOT_FOUND. Success audits `billing.pricing_undo` (when a user id is
// present) and returns { restored_version }. Versioning + DB are mocked;
// auth context and error helpers are real (header-driven).

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
  undoLastVersion: vi.fn(),
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
  undoLastVersion: mocks.undoLastVersion,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: () => undefined, error: () => undefined }),
  },
}));

const { POST, UNDO_WINDOW_SECONDS } = await import(
  '../../src/app/api/v1/customers/[id]/pricing/undo-last/route.js'
);

const OWNER_HEADERS = {
  'x-builder-id': BUILDER_ID,
  'x-user-id': USER_ID,
  'x-user-role': 'owner',
};

function routeParams(id: string = CUSTOMER_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function undoRequest(headers: Record<string, string> = OWNER_HEADERS): NextRequest {
  return new NextRequest(`http://localhost/api/v1/customers/${CUSTOMER_ID}/pricing/undo-last`, {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();

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
    cb({}),
  );
  mocks.undoLastVersion.mockResolvedValue({ restoredVersion: 2 });
  mocks.auditLog.mockResolvedValue(undefined);
});

describe('POST /api/v1/customers/[id]/pricing/undo-last', () => {
  it('exposes the documented 10-second undo window', () => {
    expect(UNDO_WINDOW_SECONDS).toBe(10);
  });

  it('returns the auth-context 500 when middleware did not set x-builder-id', async () => {
    const response = await POST(undoRequest({}), routeParams());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: 'middleware did not set x-builder-id',
      },
    });
    expect(mocks.withRole).not.toHaveBeenCalled();
    expect(mocks.undoLastVersion).not.toHaveBeenCalled();
  });

  it('rejects a Member with the withRole 403 before undoing anything', async () => {
    const response = await POST(
      undoRequest({ ...OWNER_HEADERS, 'x-user-role': 'member' }),
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
    expect(mocks.undoLastVersion).not.toHaveBeenCalled();
  });

  it('rejects a caller with no x-user-role header (role null) with 403', async () => {
    const response = await POST(
      undoRequest({ 'x-builder-id': BUILDER_ID, 'x-user-id': USER_ID }),
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
    expect(mocks.undoLastVersion).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid customer id with 400', async () => {
    const response = await POST(undoRequest(), routeParams('cust_external_1'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid customer id', param: 'id' },
    });
    expect(mocks.undoLastVersion).not.toHaveBeenCalled();
  });

  it('maps a null undo result (expired window or nothing to undo) to 410 gone', async () => {
    mocks.undoLastVersion.mockResolvedValueOnce(null);

    const response = await POST(undoRequest(), routeParams());

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: ErrorCode.NOT_FOUND,
        message: 'Undo window expired (10s) or no version to undo',
      },
    });
    expect(mocks.auditLog).not.toHaveBeenCalled();
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });

  it('undoes the last version for an Owner and audits billing.pricing_undo', async () => {
    const response = await POST(undoRequest(), routeParams());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ restored_version: 2 });
    expect(mocks.undoLastVersion).toHaveBeenCalledTimes(1);
    expect(mocks.undoLastVersion).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      customerId: CUSTOMER_ID,
      maxAgeSeconds: 10,
    });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const [, auditEntry] = mocks.auditLog.mock.calls[0]!;
    expect(auditEntry).toStrictEqual({
      builder_id: BUILDER_ID,
      actor_type: 'user',
      actor_id: USER_ID,
      action: 'billing.pricing_undo',
      resource_type: 'customer_pricing',
      details: { customer_id: CUSTOMER_ID, restored_version: 2 },
    });
    // Unlike pricing_set, the undo audit entry carries no resource_id.
    expect(auditEntry).not.toHaveProperty('resource_id');
  });

  it('returns restored_version: null when the only version was undone', async () => {
    mocks.undoLastVersion.mockResolvedValueOnce({ restoredVersion: null });

    const response = await POST(undoRequest(), routeParams());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ restored_version: null });
    const [, auditEntry] = mocks.auditLog.mock.calls[0]!;
    expect(auditEntry).toMatchObject({
      details: { customer_id: CUSTOMER_ID, restored_version: null },
    });
  });

  it('skips the audit write when the context carries no user id', async () => {
    const response = await POST(
      undoRequest({ 'x-builder-id': BUILDER_ID, 'x-user-role': 'owner' }),
      routeParams(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ restored_version: 2 });
    expect(mocks.auditLog).not.toHaveBeenCalled();
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });

  it('maps an undoLastVersion failure to a 500 internal error', async () => {
    mocks.undoLastVersion.mockRejectedValueOnce(new Error('deadlock detected'));

    const response = await POST(undoRequest(), routeParams());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Failed to undo pricing change',
      },
    });
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });
});
