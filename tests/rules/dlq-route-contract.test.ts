import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  retryDlqEntry: vi.fn(),
}));

vi.mock('@/lib/alerts/dlq-retry', () => ({
  retryDlqEntry: mocks.retryDlqEntry,
}));

vi.mock('@/lib/auth/middleware', () => ({
  Role: { OWNER: 'owner', MEMBER: 'member' },
  withRole: (allowed: string[], role: string | null) =>
    role && allowed.includes(role)
      ? null
      : Response.json(
          {
            error: {
              type: 'invalid_request_error',
              code: ErrorCode.INSUFFICIENT_PERMISSIONS,
              message: `Only ${allowed.join(', ')} can perform this action`,
            },
          },
          { status: 403 },
        ),
}));

const retryRoute = await import('../../src/app/api/v1/alerts/dlq/[id]/retry/route.js');

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const DLQ_ID = '00000000-0000-4000-8000-000000000101';

function request(role: 'owner' | 'member' = 'owner'): NextRequest {
  return new NextRequest(`http://localhost/api/v1/alerts/dlq/${DLQ_ID}/retry`, {
    method: 'POST',
    headers: {
      'x-builder-id': BUILDER_ID,
      'x-user-id': 'user-1',
      'x-user-role': role,
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

const params = { params: Promise.resolve({ id: DLQ_ID }) };

describe('POST /api/v1/alerts/dlq/[id]/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retryDlqEntry.mockResolvedValue({ kind: 'success', channel: 'slack' });
  });

  it('allows owners to retry a failed delivery', async () => {
    const response = await retryRoute.POST(request('owner'), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, channel: 'slack' });
    expect(mocks.retryDlqEntry).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      dlqId: DLQ_ID,
      actorUserId: 'user-1',
    });
  });

  it('forbids members from retrying failed deliveries', async () => {
    const response = await retryRoute.POST(request('member'), params);

    expect(response.status).toBe(403);
    expect(mocks.retryDlqEntry).not.toHaveBeenCalled();
  });

  it('returns 404 for cross-tenant, nonexistent, or already-handled entries', async () => {
    mocks.retryDlqEntry.mockResolvedValueOnce({ kind: 'not_found' });

    const response = await retryRoute.POST(request('owner'), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'DLQ entry not found or already handled',
      },
    });
  });
});
