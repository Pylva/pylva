import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthProvider } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
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

vi.mock('@/lib/config', () => ({ env: {} }));
vi.mock('@/lib/external-egress', () => ({ externalFetch: vi.fn() }));
vi.mock('@/lib/db/schema', () => ({
  users: {
    id: 'id',
    email: 'email',
    auth_provider: 'auth_provider',
    display_name: 'display_name',
    avatar_url: 'avatar_url',
  },
}));
vi.mock('@/lib/db/client', () => ({
  db: {
    insert: mocks.insert,
    select: mocks.select,
    update: mocks.update,
  },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => 'predicate') }));

const { upsertUserFromOAuth } = await import('@/lib/auth/oauth');

describe('OAuth user upsert concurrency', () => {
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

    const insertChain = {
      values: mocks.insertValues,
      onConflictDoNothing: mocks.insertOnConflictDoNothing,
      returning: mocks.insertReturning,
    };
    mocks.insertValues.mockReturnValue(insertChain);
    mocks.insertOnConflictDoNothing.mockReturnValue(insertChain);
    mocks.insert.mockReturnValue(insertChain);

    const updateChain = { set: mocks.updateSet, where: mocks.updateWhere };
    mocks.updateSet.mockReturnValue(updateChain);
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.update.mockReturnValue(updateChain);
  });

  it('returns the inserted user when this request wins first login', async () => {
    mocks.selectLimit.mockResolvedValueOnce([]);
    mocks.insertReturning.mockResolvedValueOnce([{ id: 'new-user' }]);

    await expect(
      upsertUserFromOAuth({
        email: 'New.User@example.com',
        displayName: 'New User',
        avatarUrl: 'https://cdn.example.com/new.png',
        provider: OAuthProvider.GITHUB,
      }),
    ).resolves.toMatchObject({
      userId: 'new-user',
      isNew: true,
      previousAuthProvider: null,
    });
    expect(mocks.insertOnConflictDoNothing).toHaveBeenCalledWith({ target: 'email' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('re-reads a concurrent duplicate-email winner and preserves provider merging', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'raced-user',
          auth_provider: 'magic_link',
          display_name: null,
          avatar_url: null,
        },
      ]);
    mocks.insertReturning.mockResolvedValueOnce([]);

    await expect(
      upsertUserFromOAuth({
        email: 'Duplicate@example.com',
        displayName: 'Duplicate User',
        avatarUrl: 'https://cdn.example.com/duplicate.png',
        provider: OAuthProvider.GITHUB,
      }),
    ).resolves.toEqual({
      userId: 'raced-user',
      isNew: false,
      email: 'Duplicate@example.com',
      displayName: 'Duplicate User',
      avatarUrl: 'https://cdn.example.com/duplicate.png',
      previousAuthProvider: 'magic_link',
    });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        auth_provider: 'mixed',
        display_name: 'Duplicate User',
        avatar_url: 'https://cdn.example.com/duplicate.png',
      }),
    );
  });
});
