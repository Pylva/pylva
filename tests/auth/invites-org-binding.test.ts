// Invites send/revoke read their org context from the middleware-injected
// headers (x-builder-id / x-user-id / x-user-role via
// readBuilderContextFromDashboard) — NOT from the raw session JWT. When a
// page declares x-pylva-org, the middleware scopes those headers to THAT
// org's membership; deriving from the JWT here instead would write the
// invite into whichever org the session was last minted for (wrong-org
// write when another tab switched accounts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server.js';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  warn: vi.fn(),
  withRLS: vi.fn(),
  withRole: vi.fn(),
}));

const testEnv = vi.hoisted(() => ({
  NODE_ENV: 'production',
  LOG_LEVEL: 'silent',
  OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
  INVITE_TTL_HOURS: 72,
  INVITE_FROM_EMAIL: 'invites@pylva.dev',
  RESEND_API_KEY: undefined,
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));
vi.mock('../../src/lib/db/client.js', () => ({ db: {} }));

// The real middleware module drags in redis/jwt/api-key wiring. The routes
// only use withRole + Role from it; the mock mirrors the real owner gate so
// the header-derived role is exercised end to end. Deliberately NO
// withJwtAuth export: if a route regressed to calling it, the import blows
// up instead of silently passing.
vi.mock('@/lib/auth/middleware', async () => {
  const { Role, ErrorCode } = await import('@pylva/shared');
  const { forbiddenError } = await import('../../src/lib/errors.js');
  return {
    Role,
    withRole: mocks.withRole.mockImplementation(
      (allowed: readonly string[], ctxRole: string | null) =>
        ctxRole !== null && allowed.includes(ctxRole)
          ? null
          : forbiddenError(
              ErrorCode.INSUFFICIENT_PERMISSIONS,
              'Only owner can perform this action',
            ),
    ),
  };
});

vi.mock('@/lib/db/rls', () => ({ withRLS: mocks.withRLS }));
vi.mock('@/lib/auth/audit-log', () => ({ auditLog: mocks.auditLog }));
vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      warn: mocks.warn,
    }),
  },
}));

const { POST: sendInvite } = await import('../../src/app/api/v1/invites/send/route.js');
const { DELETE: revokeInvite } = await import(
  '../../src/app/api/v1/invites/revoke/[id]/route.js'
);

function fakeTx(): Record<string, unknown> {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        mocks.insertValues(values);
        return { returning: () => Promise.resolve([{ id: 'invite-1' }]) };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateSet(values);
        return {
          where: () => ({ returning: () => Promise.resolve([{ id: 'invite-1' }]) }),
        };
      },
    }),
  };
}

const OWNER_HEADERS = {
  'x-builder-id': 'builder-from-header',
  'x-user-id': 'user-from-header',
  'x-user-role': 'owner',
  // A stale session cookie for a DIFFERENT org: the route must never read
  // it — org context comes exclusively from the injected headers.
  cookie: 'pylva_session=jwt-minted-for-some-other-org',
};

function sendRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://app.example.com/api/v1/invites/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'Invitee@Example.com', role: 'member' }),
  });
}

async function revoke(headers: Record<string, string>): Promise<NextResponse> {
  return revokeInvite(
    new NextRequest('https://app.example.com/api/v1/invites/revoke/invite-1', {
      method: 'DELETE',
      headers,
    }),
    { params: Promise.resolve({ id: 'invite-1' }) },
  );
}

// Dev path (no RESEND_API_KEY) prints the invite link via console.warn —
// keep test output clean.
vi.spyOn(console, 'warn').mockImplementation(() => undefined);

function headersWithout(name: string): Record<string, string> {
  const headers: Record<string, string> = { ...OWNER_HEADERS };
  delete headers[name];
  return headers;
}

describe('invites org binding via middleware headers', () => {
  beforeEach(() => {
    mocks.auditLog.mockReset();
    mocks.insertValues.mockReset();
    mocks.updateSet.mockReset();
    mocks.warn.mockReset();
    mocks.withRLS.mockReset();
    mocks.withRole.mockClear();

    mocks.withRLS.mockImplementation(
      async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx()),
    );
  });

  describe('POST /api/v1/invites/send', () => {
    it('binds the invite insert to the x-builder-id header, not any JWT', async () => {
      const response = await sendInvite(sendRequest(OWNER_HEADERS));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        invite_id: 'invite-1',
      });
      expect(mocks.withRLS).toHaveBeenCalledWith('builder-from-header', expect.any(Function));
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          builder_id: 'builder-from-header',
          invited_by_user_id: 'user-from-header',
          email: 'invitee@example.com',
          role: 'member',
        }),
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'org.member_invited',
          builder_id: 'builder-from-header',
          actor_id: 'user-from-header',
        }),
      );
    });

    it('gates ownership on the x-user-role header', async () => {
      const response = await sendInvite(
        sendRequest({ ...OWNER_HEADERS, 'x-user-role': 'member' }),
      );

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(mocks.withRole).toHaveBeenCalledWith(['owner'], 'member');
      expect(mocks.withRLS).not.toHaveBeenCalled();
      expect(mocks.insertValues).not.toHaveBeenCalled();
    });

    it('returns a 500 internalError when middleware did not inject x-builder-id', async () => {
      const response = await sendInvite(sendRequest(headersWithout('x-builder-id')));

      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe('api_error');
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(mocks.withRLS).not.toHaveBeenCalled();
      expect(mocks.insertValues).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/invites/revoke/[id]', () => {
    it('binds the revoke update to the x-builder-id header, not any JWT', async () => {
      const response = await revoke(OWNER_HEADERS);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(mocks.withRLS).toHaveBeenCalledWith('builder-from-header', expect.any(Function));
      expect(mocks.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ expires_at: expect.any(Date) }),
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'org.invite_revoked',
          builder_id: 'builder-from-header',
          actor_id: 'user-from-header',
          resource_id: 'invite-1',
        }),
      );
    });

    it('gates ownership on the x-user-role header', async () => {
      const response = await revoke({ ...OWNER_HEADERS, 'x-user-role': 'member' });

      expect(response.status).toBe(403);
      expect(mocks.withRole).toHaveBeenCalledWith(['owner'], 'member');
      expect(mocks.withRLS).not.toHaveBeenCalled();
    });

    it('returns a 500 internalError when middleware did not inject x-builder-id', async () => {
      const response = await revoke(headersWithout('x-builder-id'));

      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(mocks.withRLS).not.toHaveBeenCalled();
    });
  });
});
