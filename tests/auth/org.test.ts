import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type TableName = 'builders' | 'memberships' | 'unknown';

  const tableNames = new WeakMap<object, TableName>();
  const selectRows: unknown[][] = [];
  const builderInsertRows: unknown[][] = [];
  const selectCalls: Array<{ table: TableName; where: unknown }> = [];
  const insertCalls: Array<{ table: TableName; values: Record<string, unknown> }> = [];
  const onConflictCalls: TableName[] = [];
  const info = vi.fn();

  function tableName(table: unknown): TableName {
    return typeof table === 'object' && table !== null
      ? (tableNames.get(table as object) ?? 'unknown')
      : 'unknown';
  }

  function nextSelectRows(): unknown[] {
    return selectRows.shift() ?? [];
  }

  function select() {
    let currentTable: TableName = 'unknown';
    const leaf = (where: unknown) => {
      selectCalls.push({ table: currentTable, where });
      return {
        limit: () => Promise.resolve(nextSelectRows()),
        orderBy: () => ({
          limit: () => Promise.resolve(nextSelectRows()),
        }),
      };
    };
    const afterFrom = {
      innerJoin: () => afterFrom,
      where: leaf,
    };
    return {
      from: (table: unknown) => {
        currentTable = tableName(table);
        return afterFrom;
      },
    };
  }

  function insert(table: unknown) {
    const currentTable = tableName(table);
    return {
      values: (values: Record<string, unknown>) => {
        insertCalls.push({ table: currentTable, values });
        return {
          onConflictDoNothing: () => {
            onConflictCalls.push(currentTable);
            if (currentTable === 'builders') {
              return { returning: () => Promise.resolve(builderInsertRows.shift() ?? []) };
            }
            return Promise.resolve(undefined);
          },
        };
      },
    };
  }

  const tx = { insert, select };
  const db = {
    insert,
    select,
    transaction: vi.fn(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
  };

  return {
    db,
    info,
    state: {
      builderInsertRows,
      insertCalls,
      onConflictCalls,
      selectCalls,
      selectRows,
      tableNames,
      reset() {
        builderInsertRows.length = 0;
        insertCalls.length = 0;
        onConflictCalls.length = 0;
        selectCalls.length = 0;
        selectRows.length = 0;
        db.transaction.mockClear();
        info.mockReset();
      },
    },
  };
});

vi.mock('../../src/lib/db/client.js', () => ({
  db: mocks.db,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: mocks.info,
    }),
  },
}));

const schema = await import('../../src/lib/db/schema.js');
mocks.state.tableNames.set(schema.builders, 'builders');
mocks.state.tableNames.set(schema.userBuilderMemberships, 'memberships');

const { findOrCreateBuilderForUser } = await import('../../src/lib/auth/org.js');

function whereText(value: unknown): string {
  return inspect(value, { depth: null, breakLength: Infinity }).toLowerCase();
}

describe('findOrCreateBuilderForUser', () => {
  beforeEach(() => {
    mocks.state.reset();
  });

  it('returns an existing membership without creating or adopting a builder', async () => {
    mocks.state.selectRows.push([
      {
        builder_id: 'builder-existing',
        role: 'member',
        slug: 'existing-workspace',
        tier: 'pro',
      },
    ]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        avatarUrl: null,
      }),
    ).resolves.toEqual({
      builderId: 'builder-existing',
      isNew: false,
      role: 'member',
      slug: 'existing-workspace',
      tier: 'pro',
    });

    expect(mocks.state.insertCalls).toEqual([]);
  });

  it('attaches an existing email-matching builder as owner when the user has no membership', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          id: 'builder-legacy',
          slug: 'legacy-workspace',
          tier: 'scale',
        },
      ],
    );

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-legacy',
        email: 'legacy@example.com',
        displayName: 'Legacy Owner',
        avatarUrl: 'https://cdn.example.com/avatar.png',
      }),
    ).resolves.toEqual({
      builderId: 'builder-legacy',
      isNew: false,
      role: 'owner',
      slug: 'legacy-workspace',
      tier: 'scale',
    });

    expect(mocks.state.insertCalls).toEqual([
      {
        table: 'memberships',
        values: {
          builder_id: 'builder-legacy',
          role: 'owner',
          user_id: 'user-legacy',
        },
      },
    ]);
    expect(mocks.state.onConflictCalls).toEqual(['memberships']);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ builderId: 'builder-legacy', reason: 'email_match' }),
      'existing builder attached to authenticated user',
    );
  });

  it('uses a case-insensitive email lookup before creating a new builder', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          id: 'builder-case',
          slug: 'case-workspace',
          tier: 'enterprise',
        },
      ],
    );

    await findOrCreateBuilderForUser({
      userId: 'user-case',
      email: 'Owner@Example.COM',
      displayName: null,
      avatarUrl: null,
    });

    const builderLookup = mocks.state.selectCalls.find((call) => call.table === 'builders');
    expect(builderLookup).toBeDefined();
    expect(whereText(builderLookup!.where)).toContain('lower');
  });

  it('creates a normalized-email builder and owner membership for a new signup', async () => {
    mocks.state.selectRows.push([], []);
    mocks.state.builderInsertRows.push([{ id: 'builder-new' }]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-new',
        email: 'New.Owner@Example.COM',
        displayName: 'New Owner',
        avatarUrl: 'https://cdn.example.com/new.png',
      }),
    ).resolves.toEqual({
      builderId: 'builder-new',
      isNew: true,
      role: 'owner',
      slug: 'new-owner',
      tier: 'free',
    });

    expect(mocks.state.insertCalls).toEqual([
      {
        table: 'builders',
        values: expect.objectContaining({
          avatar_url: 'https://cdn.example.com/new.png',
          display_name: 'New Owner',
          email: 'new.owner@example.com',
          name: 'New Owner',
          slug: 'new-owner',
          tier: 'free',
        }),
      },
      {
        table: 'memberships',
        values: {
          builder_id: 'builder-new',
          role: 'owner',
          user_id: 'user-new',
        },
      },
    ]);
    expect(mocks.state.onConflictCalls).toEqual(['builders', 'memberships']);
  });

  it('handles an email unique race by rereading and adopting the raced builder', async () => {
    mocks.state.selectRows.push(
      [],
      [],
      [
        {
          id: 'builder-race',
          slug: 'raced-workspace',
          tier: 'pro',
        },
      ],
    );
    mocks.state.builderInsertRows.push([]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-race',
        email: 'race@example.com',
        displayName: 'Race Owner',
        avatarUrl: null,
      }),
    ).resolves.toEqual({
      builderId: 'builder-race',
      isNew: false,
      role: 'owner',
      slug: 'raced-workspace',
      tier: 'pro',
    });

    expect(mocks.state.insertCalls).toEqual([
      {
        table: 'builders',
        values: expect.objectContaining({ email: 'race@example.com' }),
      },
      {
        table: 'memberships',
        values: {
          builder_id: 'builder-race',
          role: 'owner',
          user_id: 'user-race',
        },
      },
    ]);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ builderId: 'builder-race', reason: 'email_conflict_race' }),
      'existing builder attached to authenticated user',
    );
  });

  it('does not overwrite existing builder metadata while adopting by email', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          id: 'builder-preserve',
          slug: 'preserve-slug',
          tier: 'scale',
        },
      ],
    );

    await findOrCreateBuilderForUser({
      userId: 'user-preserve',
      email: 'preserve@example.com',
      displayName: 'Different OAuth Name',
      avatarUrl: 'https://cdn.example.com/different.png',
    });

    expect(mocks.state.insertCalls).toEqual([
      {
        table: 'memberships',
        values: {
          builder_id: 'builder-preserve',
          role: 'owner',
          user_id: 'user-preserve',
        },
      },
    ]);
  });

  it('uses idempotent membership insertion for adopted builders', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          id: 'builder-idempotent',
          slug: 'idempotent-workspace',
          tier: 'free',
        },
      ],
    );

    await findOrCreateBuilderForUser({
      userId: 'user-idempotent',
      email: 'idempotent@example.com',
      displayName: null,
      avatarUrl: null,
    });

    expect(mocks.state.onConflictCalls).toEqual(['memberships']);
  });
});
