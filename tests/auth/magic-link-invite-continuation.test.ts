import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  sendCommand: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ env: { MAGIC_LINK_TTL_SECONDS: 900 } }));
vi.mock('@/lib/redis/client', () => ({
  redisClient: { set: mocks.redisSet, sendCommand: mocks.sendCommand },
}));
vi.mock('@/lib/db/schema', () => ({
  users: { id: 'id', email: 'email', auth_provider: 'auth_provider' },
}));
vi.mock('@/lib/db/client', () => ({
  db: { select: mocks.select, update: mocks.update },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => 'predicate') }));

const { consumeMagicToken, issueMagicToken } = await import('@/lib/auth/magic-link');

describe('magic-link pending invite continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const selectChain = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(async () => [{ id: 'user-1', auth_provider: 'magic_link' }]),
    };
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    mocks.select.mockReturnValue(selectChain);

    const updateChain = { set: vi.fn(), where: vi.fn(async () => undefined) };
    updateChain.set.mockReturnValue(updateChain);
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
});
