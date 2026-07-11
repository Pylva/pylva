import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';

const TOKEN = 'd'.repeat(64);

const mocks = vi.hoisted(() => ({
  withJwtAuth: vi.fn(),
  setDashboardSessionCookies: vi.fn(),
  signJwt: vi.fn(),
  revokeJwt: vi.fn(),
  invalidateMembershipCache: vi.fn(),
  auditLog: vi.fn(),
  claimed: true,
  candidate: true,
  inserted: vi.fn(),
  membershipRole: 'member',
}));

vi.mock('@/lib/config', () => ({
  env: {
    MAGIC_LINK_TTL_SECONDS: 900,
    NODE_ENV: 'test',
    OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
    SESSION_COOKIE_SECURE: true,
  },
}));
vi.mock('@/lib/auth/middleware', () => ({
  withJwtAuth: mocks.withJwtAuth,
  setDashboardSessionCookies: mocks.setDashboardSessionCookies,
}));
vi.mock('@/lib/auth/jwt', () => ({ signJwt: mocks.signJwt, revokeJwt: mocks.revokeJwt }));
vi.mock('@/lib/auth/membership-cache', () => ({
  invalidateMembershipCache: mocks.invalidateMembershipCache,
}));
vi.mock('@/lib/auth/audit-log', () => ({ auditLog: mocks.auditLog }));
vi.mock('@/lib/logger', () => ({ logger: { child: () => ({ info: vi.fn() }) } }));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (...values: unknown[]) => ({ eq: values }),
  gt: (...values: unknown[]) => ({ gt: values }),
  isNull: (value: unknown) => ({ isNull: value }),
}));
vi.mock('@/lib/db/schema', () => ({
  invites: {
    id: 'invite.id',
    builder_id: 'invite.builder_id',
    email: 'invite.email',
    role: 'invite.role',
    token: 'invite.token',
    accepted_at: 'invite.accepted_at',
    expires_at: 'invite.expires_at',
  },
  users: { id: 'users.id', email: 'users.email' },
  userBuilderMemberships: {
    user_id: 'membership.user_id',
    builder_id: 'membership.builder_id',
    role: 'membership.role',
  },
  builders: { id: 'builders.id', slug: 'builders.slug', tier: 'builders.tier' },
}));

function queryResult(result: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(async () => result),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

const db = {
  select: vi.fn((projection: Record<string, unknown>) =>
    queryResult(
      'builder_id' in projection
        ? mocks.candidate
          ? [
              {
                id: 'invite-1',
                builder_id: 'builder-1',
                email: 'user@example.com',
              },
            ]
          : []
        : [{ email: 'user@example.com' }],
    ),
  ),
};
vi.mock('@/lib/db/client', () => ({ db }));

function transaction() {
  const updateChain = {
    set: vi.fn(),
    where: vi.fn(),
    returning: vi.fn(async () => (mocks.claimed ? [{ id: 'invite-1', role: 'owner' }] : [])),
  };
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockReturnValue(updateChain);
  const insertChain = {
    values: vi.fn(),
    onConflictDoNothing: vi.fn(async () => {
      mocks.inserted();
    }),
  };
  insertChain.values.mockReturnValue(insertChain);
  return {
    update: vi.fn(() => updateChain),
    insert: vi.fn(() => insertChain),
    select: vi.fn(() => queryResult([{ role: mocks.membershipRole, slug: 'acme', tier: 'scale' }])),
  };
}

vi.mock('@/lib/db/rls', () => ({
  withRLS: vi.fn(async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) =>
    callback(transaction()),
  ),
}));

const { GET } = await import('@/app/api/v1/invites/accept/route');

function request(): NextRequest {
  return new NextRequest(`https://app.example.com/api/v1/invites/accept?token=${TOKEN}`);
}

describe('invite acceptance atomicity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimed = true;
    mocks.candidate = true;
    mocks.membershipRole = 'member';
    mocks.withJwtAuth.mockResolvedValue({
      context: {
        builderId: 'old-builder',
        userId: 'user-1',
        orgSlug: 'old-org',
        role: 'owner',
        tier: 'free',
        jti: 'leaf-1',
        revocationId: 'family-1',
      },
      refreshToken: null,
      sessionToken: 'old-token',
    });
    mocks.signJwt.mockResolvedValue('replacement-token');
  });

  it('mints from the committed membership role and revokes the prior family', async () => {
    const response = await GET(request());

    expect(response.headers.get('location')).toBe('https://app.example.com/o/acme/dashboard');
    expect(mocks.inserted).toHaveBeenCalledTimes(1);
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'member', org_slug: 'acme' }),
    );
    expect(mocks.revokeJwt).toHaveBeenCalledWith('family-1', 'pylva:dashboard', 86_400);
    expect(mocks.setDashboardSessionCookies).toHaveBeenCalledWith(response, {
      token: 'replacement-token',
      userId: 'user-1',
      orgSlug: 'acme',
    });
    expect(response.cookies.get('pylva_pending_invite')?.value).toBe('');
  });

  it('fails when a concurrent revoke or expiry wins the conditional claim', async () => {
    mocks.claimed = false;

    const response = await GET(request());

    expect(response.status).toBe(410);
    expect(mocks.inserted).not.toHaveBeenCalled();
    expect(mocks.signJwt).not.toHaveBeenCalled();
    expect(mocks.revokeJwt).not.toHaveBeenCalled();
    expect(response.cookies.get('pylva_pending_invite')?.value).toBe('');
  });

  it('parks only an HttpOnly cookie and keeps the login URL clean when unauthenticated', async () => {
    mocks.withJwtAuth.mockResolvedValue(NextResponse.json({}, { status: 401 }));

    const response = await GET(request());

    expect(response.headers.get('location')).toBe('https://app.example.com/login?invite=1');
    expect(response.headers.get('location')).not.toContain(TOKEN);
    const pending = response.cookies.get('pylva_pending_invite');
    expect(pending?.value).toBe(TOKEN);
    expect(pending?.httpOnly).toBe(true);
    expect(mocks.signJwt).not.toHaveBeenCalled();
  });
});
