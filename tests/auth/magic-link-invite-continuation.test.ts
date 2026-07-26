import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  sendCommand: vi.fn(),
  insert: vi.fn(),
  insertOnConflictDoNothing: vi.fn(),
  insertReturning: vi.fn(),
  insertValues: vi.fn(),
  select: vi.fn(),
  selectLimit: vi.fn(),
  update: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ env: { MAGIC_LINK_TTL_SECONDS: 900 } }));
vi.mock('@/lib/redis/client', () => ({
  redisClient: { set: mocks.redisSet, sendCommand: mocks.sendCommand },
}));
vi.mock('@/lib/db/schema', () => ({
  users: { id: 'id', email: 'email', auth_provider: 'auth_provider' },
}));
vi.mock('@/lib/db/client', () => ({
  db: { insert: mocks.insert, select: mocks.select, update: mocks.update },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => 'predicate') }));

const { consumeMagicToken, issueMagicToken } = await import('@/lib/auth/magic-link');

describe('magic-link pending invite continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: mocks.selectLimit,
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    mocks.select.mockReturnValue(selectChain);
    mocks.selectLimit.mockResolvedValue([{ id: 'user-1', auth_provider: 'magic_link' }]);

    const insertChain = {
      values: mocks.insertValues,
      onConflictDoNothing: mocks.insertOnConflictDoNothing,
      returning: mocks.insertReturning,
    };
    mocks.insertValues.mockReturnValue(insertChain);
    mocks.insertOnConflictDoNothing.mockReturnValue(insertChain);
    mocks.insertReturning.mockResolvedValue([{ id: 'new-user' }]);
    mocks.insert.mockReturnValue(insertChain);

    const updateChain = { set: mocks.updateSet, where: mocks.updateWhere };
    mocks.updateSet.mockReturnValue(updateChain);
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.update.mockReturnValue(updateChain);
    mocks.redisSet.mockResolvedValue('OK');
  });

  it('copies the validated invite token into Redis so another browser can resume it', async () => {
    const pendingInviteToken = 'c'.repeat(64);
    const issued = await issueMagicToken({
      email: 'Invitee@Example.com',
      next: '/o/acme/dashboard/rules',
      pendingInviteToken,
    });
    const stored = JSON.parse(mocks.redisSet.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(stored).toEqual({
      email: 'invitee@example.com',
      next: '/o/acme/dashboard/rules',
      pendingInviteToken,
    });

    mocks.sendCommand.mockResolvedValue(JSON.stringify(stored));
    const consumed = await consumeMagicToken(issued.token);

    expect(consumed).toEqual(expect.objectContaining({ userId: 'user-1', pendingInviteToken }));
    expect(mocks.sendCommand).toHaveBeenCalledWith(['GETDEL', `magic:${issued.token}`]);
  });

  it('drops malformed invite state from an otherwise valid magic payload', async () => {
    mocks.sendCommand.mockResolvedValue(
      JSON.stringify({ email: 'invitee@example.com', pendingInviteToken: 'not-a-token' }),
    );

    await expect(consumeMagicToken('magic-token')).resolves.toEqual(
      expect.objectContaining({ pendingInviteToken: null }),
    );
  });

  it('re-reads a concurrent duplicate-email winner and merges its OAuth provider', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'raced-user', auth_provider: 'oauth_github' }]);
    mocks.insertReturning.mockResolvedValueOnce([]);
    mocks.sendCommand.mockResolvedValue(
      JSON.stringify({ email: 'invitee@example.com' }),
    );

    await expect(consumeMagicToken('magic-token')).resolves.toEqual({
      userId: 'raced-user',
      email: 'invitee@example.com',
      isNewUser: false,
      next: null,
      pendingInviteToken: null,
    });
    expect(mocks.insertOnConflictDoNothing).toHaveBeenCalledWith({ target: 'email' });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ auth_provider: 'mixed' }),
    );
  });
});
