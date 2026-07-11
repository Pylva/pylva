import crypto from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest, NextResponse } from 'next/server.js';

process.env['OAUTH_REDIRECT_BASE_URL'] = 'https://app.example.com';
process.env['SESSION_COOKIE_NAME'] = 'pylva_session';
process.env['SESSION_COOKIE_SECURE'] = 'true';

const mocks = vi.hoisted(() => {
  class MockAuthDegraded extends Error {}
  return {
    AuthDegraded: MockAuthDegraded,
    auditLog: vi.fn(),
    consumeMagicToken: vi.fn(),
    setDashboardSessionCookies: vi.fn(),
    setRefreshCookie: vi.fn(),
    signJwt: vi.fn(),
    withRLS: vi.fn(),
  };
});

vi.mock('@/lib/auth/magic-link', () => ({
  AuthDegraded: mocks.AuthDegraded,
  consumeMagicToken: mocks.consumeMagicToken,
}));
vi.mock('@/lib/auth/jwt', () => ({ signJwt: mocks.signJwt }));
vi.mock('@/lib/auth/middleware', () => ({
  setDashboardSessionCookies: mocks.setDashboardSessionCookies,
}));
vi.mock('@/lib/auth/audit-log', () => ({ auditLog: mocks.auditLog }));
vi.mock('@/lib/db/rls', () => ({ withRLS: mocks.withRLS }));

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
const { GET } = await import('../../src/app/api/v1/auth/magic/verify/route.js');

function request(token: string): NextRequest {
  return {
    url: `https://app.example.com/api/v1/auth/magic/verify?token=${token}`,
  } as NextRequest;
}

async function cleanup(email: string): Promise<void> {
  await sql`DELETE FROM builders WHERE lower(email) = ${email.toLowerCase()}`;
  await sql`DELETE FROM users WHERE lower(email::text) = ${email.toLowerCase()}`;
}

describe('magic-link legacy builder adoption integration', () => {
  beforeEach(() => {
    mocks.auditLog.mockReset();
    mocks.consumeMagicToken.mockReset();
    mocks.setDashboardSessionCookies.mockReset();
    mocks.setRefreshCookie.mockReset();
    mocks.signJwt.mockReset();
    mocks.withRLS.mockReset();
    mocks.signJwt.mockResolvedValue('signed-dashboard-jwt');
    mocks.setRefreshCookie.mockImplementation((response: NextResponse, token: string) => {
      response.cookies.set('pylva_session', token, { httpOnly: true, path: '/' });
    });
    mocks.setDashboardSessionCookies.mockImplementation(
      (response: NextResponse, params: { token: string }) => {
        mocks.setRefreshCookie(response, params.token);
      },
    );
    mocks.withRLS.mockImplementation(
      async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  it('links a matching user and mixed-case builder exactly once', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    const email = `magic-${suffix}@example.com`;
    const slug = `magic-${suffix}`;
    await cleanup(email);

    try {
      const [builder] = await sql<{ id: string }[]>`
        INSERT INTO builders (email, name, tier, slug)
        VALUES (${email.toUpperCase()}, 'Magic Legacy', 'enterprise', ${slug})
        RETURNING id
      `;
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO users (email, auth_provider)
        VALUES (${email}, 'magic_link')
        RETURNING id
      `;
      mocks.consumeMagicToken.mockResolvedValue({
        email,
        isNewUser: false,
        next: null,
        userId: user!.id,
      });

      const first = await GET(request('first-magic-token'));
      const second = await GET(request('second-magic-token'));

      for (const response of [first, second]) {
        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(
          `https://app.example.com/o/${slug}/dashboard`,
        );
        expect(response.headers.get('set-cookie')).toContain('pylva_session=signed-dashboard-jwt');
      }
      const memberships = await sql<{ role: string }[]>`
        SELECT role FROM user_builder_memberships
        WHERE builder_id = ${builder!.id} AND user_id = ${user!.id}
      `;
      expect(memberships).toEqual([{ role: 'owner' }]);
      expect(mocks.signJwt).toHaveBeenLastCalledWith(
        expect.objectContaining({ builder_id: builder!.id, tier: 'enterprise' }),
      );
    } finally {
      await cleanup(email);
    }
  });
});
