import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type TableName = 'builders' | 'invites' | 'memberships' | 'unknown';

  const tableNames = new WeakMap<object, TableName>();
  const selectRows: unknown[][] = [];
  const builderInsertRows: unknown[][] = [];
  const inviteUpdateRows: unknown[][] = [];
  const executeRows: unknown[][] = [];
  const executeCalls: unknown[] = [];
  const selectCalls: Array<{ table: TableName; where: unknown }> = [];
  const insertCalls: Array<{ table: TableName; values: Record<string, unknown> }> = [];
  const onConflictCalls: TableName[] = [];
  const updateCalls: Array<{ table: TableName; values: Record<string, unknown> }> = [];
  const error = vi.fn();
  const info = vi.fn();
  const assertHostedProvisionalSignupEnabledTx = vi.fn();
  let deploymentMode: 'hosted' | 'self_hosted' = 'hosted';

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

  function update(table: unknown) {
    const currentTable = tableName(table);
    return {
      set: (values: Record<string, unknown>) => {
        updateCalls.push({ table: currentTable, values });
        return {
          where: () => ({
            returning: () => Promise.resolve(inviteUpdateRows.shift() ?? []),
          }),
        };
      },
    };
  }

  function execute(query: unknown) {
    executeCalls.push(query);
    return Promise.resolve(executeRows.shift() ?? []);
  }

  const tx = { execute, insert, select, update };
  const db = {
    execute,
    insert,
    select,
    update,
    transaction: vi.fn(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
  };

  return {
    db,
    get deploymentMode() {
      return deploymentMode;
    },
    set deploymentMode(value: 'hosted' | 'self_hosted') {
      deploymentMode = value;
    },
    error,
    info,
    assertHostedProvisionalSignupEnabledTx,
    state: {
      builderInsertRows,
      executeCalls,
      executeRows,
      inviteUpdateRows,
      insertCalls,
      onConflictCalls,
      selectCalls,
      selectRows,
      tableNames,
      updateCalls,
      reset() {
        builderInsertRows.length = 0;
        executeCalls.length = 0;
        executeRows.length = 0;
        insertCalls.length = 0;
        inviteUpdateRows.length = 0;
        onConflictCalls.length = 0;
        selectCalls.length = 0;
        selectRows.length = 0;
        updateCalls.length = 0;
        deploymentMode = 'hosted';
        db.transaction.mockClear();
        error.mockReset();
        info.mockReset();
        assertHostedProvisionalSignupEnabledTx.mockReset();
        assertHostedProvisionalSignupEnabledTx.mockResolvedValue(undefined);
      },
    },
  };
});

vi.mock('../../src/lib/db/client.js', () => ({
  db: mocks.db,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: vi.fn(
    async (_builderId: string, callback: (tx: typeof mocks.db) => Promise<unknown>) =>
      callback(mocks.db),
  ),
}));

vi.mock('../../src/lib/config.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'PYLVA_DEPLOYMENT_MODE' ? mocks.deploymentMode : undefined,
    },
  ),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      error: mocks.error,
      info: mocks.info,
    }),
  },
}));

vi.mock('../../src/lib/auth/hosted-provisional-signup.js', () => ({
  assertHostedProvisionalSignupEnabledTx:
    mocks.assertHostedProvisionalSignupEnabledTx,
}));

const schema = await import('../../src/lib/db/schema.js');
mocks.state.tableNames.set(schema.builders, 'builders');
mocks.state.tableNames.set(schema.invites, 'invites');
mocks.state.tableNames.set(schema.userBuilderMemberships, 'memberships');

const {
  findOrCreateBuilderForUser,
  resolveSlugForUser,
  switchActiveOrg,
} = await import('../../src/lib/auth/org.js');

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
        plan: 'pro',
        access_state: 'active',
        entitlement_source: 'stripe',
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
      plan: 'pro',
      accessState: 'active',
      entitlementSource: 'stripe',
      acceptedInviteId: null,
    });

    expect(mocks.state.insertCalls).toEqual([]);
    expect(
      mocks.assertHostedProvisionalSignupEnabledTx,
    ).not.toHaveBeenCalled();
  });

  it('normalizes an old-writer legacy Free membership to checkout-required', async () => {
    mocks.state.selectRows.push([
      {
        builder_id: 'builder-expand-race',
        role: 'owner',
        slug: 'expand-race',
        plan: 'free',
        access_state: null,
        entitlement_source: null,
      },
    ]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-expand-race',
        email: 'expand@example.com',
        displayName: null,
        avatarUrl: null,
      }),
    ).resolves.toMatchObject({
      builderId: 'builder-expand-race',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
      isNew: false,
    });
    expect(mocks.state.insertCalls).toEqual([]);
  });

  it('fails closed on every malformed existing membership tuple', async () => {
    mocks.state.selectRows.push([
      {
        builder_id: 'builder-corrupt',
        role: 'owner',
        slug: 'corrupt',
        plan: 'pro',
        access_state: null,
        entitlement_source: null,
      },
    ]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-corrupt',
        email: 'corrupt@example.com',
        displayName: null,
        avatarUrl: null,
      }),
    ).rejects.toThrow('Invalid builder entitlement');
    expect(mocks.state.insertCalls).toEqual([]);
  });

  it('attaches an existing email-matching builder as owner when the user has no membership', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          id: 'builder-legacy',
          slug: 'legacy-workspace',
          plan: 'scale',
          access_state: 'active',
          entitlement_source: 'stripe',
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
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      acceptedInviteId: null,
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

  it('normalizes an old-writer legacy Free builder before adopting it by email', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          id: 'builder-old-writer',
          slug: 'old-writer',
          plan: 'free',
          access_state: null,
          entitlement_source: null,
        },
      ],
    );

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-old-writer',
        email: 'old-writer@example.com',
        displayName: null,
        avatarUrl: null,
      }),
    ).resolves.toMatchObject({
      builderId: 'builder-old-writer',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
    });
  });

  it('uses a case-insensitive email lookup before creating a new builder', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          id: 'builder-case',
          slug: 'case-workspace',
          plan: 'enterprise',
          access_state: 'active',
          entitlement_source: 'enterprise_contract',
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

  it('creates a hosted checkout-required workspace without a commercial plan', async () => {
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
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
      acceptedInviteId: null,
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
          tier: null,
          access_state: 'checkout_required',
          entitlement_source: null,
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
    expect(
      mocks.assertHostedProvisionalSignupEnabledTx,
    ).toHaveBeenCalledOnce();
  });

  it('creates no provisional workspace while hosted rollout enablement is disabled', async () => {
    mocks.state.selectRows.push([], []);
    mocks.assertHostedProvisionalSignupEnabledTx.mockRejectedValueOnce(
      new Error('hosted provisional signup disabled'),
    );

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-cutover',
        email: 'cutover@example.com',
        displayName: 'Cutover',
        avatarUrl: null,
      }),
    ).rejects.toThrow('hosted provisional signup disabled');

    expect(
      mocks.state.insertCalls.some((call) => call.table === 'builders'),
    ).toBe(false);
  });

  it('handles an email unique race by rereading and adopting the raced builder', async () => {
    mocks.state.selectRows.push(
      [],
      [],
      [
        {
          id: 'builder-race',
          slug: 'raced-workspace',
          plan: 'pro',
          access_state: 'active',
          entitlement_source: 'stripe',
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
      plan: 'pro',
      accessState: 'active',
      entitlementSource: 'stripe',
      acceptedInviteId: null,
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
          plan: 'scale',
          access_state: 'active',
          entitlement_source: 'stripe',
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
          plan: 'pro',
          access_state: 'active',
          entitlement_source: 'stripe',
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

  it('creates an active planless self-hosted workspace with explicit source', async () => {
    mocks.deploymentMode = 'self_hosted';
    mocks.state.selectRows.push([], []);
    mocks.state.builderInsertRows.push([{ id: 'builder-self-hosted' }]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-self-hosted',
        email: 'operator@example.com',
        displayName: 'Operator',
        avatarUrl: null,
      }),
    ).resolves.toMatchObject({
      builderId: 'builder-self-hosted',
      plan: null,
      accessState: 'active',
      entitlementSource: 'self_hosted',
    });

    expect(mocks.state.insertCalls[0]?.values).toEqual(
      expect.objectContaining({
        tier: null,
        access_state: 'active',
        entitlement_source: 'self_hosted',
      }),
    );
    expect(
      mocks.assertHostedProvisionalSignupEnabledTx,
    ).not.toHaveBeenCalled();
  });

  it('atomically accepts a matching pending invite before creating a personal workspace', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          slug: 'invited-workspace',
          role: 'member',
          plan: 'scale',
          access_state: 'active',
          entitlement_source: 'stripe',
        },
      ],
    );
    mocks.state.inviteUpdateRows.push([
      { id: 'invite-1', builder_id: 'builder-invited', role: 'member' },
    ]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-invited',
        email: 'Invitee@Example.com',
        displayName: 'Invitee',
        avatarUrl: null,
        pendingInviteToken: 'a'.repeat(64),
      }),
    ).resolves.toEqual({
      builderId: 'builder-invited',
      slug: 'invited-workspace',
      role: 'member',
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: 'invite-1',
    });

    expect(mocks.state.insertCalls).toEqual([
      {
        table: 'memberships',
        values: {
          builder_id: 'builder-invited',
          role: 'member',
          user_id: 'user-invited',
        },
      },
    ]);
    expect(mocks.state.insertCalls.some((call) => call.table === 'builders')).toBe(false);
    expect(
      mocks.assertHostedProvisionalSignupEnabledTx,
    ).not.toHaveBeenCalled();
    expect(mocks.state.updateCalls).toEqual([
      { table: 'invites', values: { accepted_at: expect.any(Date) } },
    ]);
  });

  it('normalizes an invited old-writer legacy Free workspace before session issuance', async () => {
    mocks.state.selectRows.push(
      [],
      [
        {
          slug: 'invited-expand-race',
          role: 'member',
          plan: 'free',
          access_state: null,
          entitlement_source: null,
        },
      ],
    );
    mocks.state.inviteUpdateRows.push([
      { id: 'invite-expand', builder_id: 'builder-expand', role: 'member' },
    ]);

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-invited-expand',
        email: 'invited@example.com',
        displayName: null,
        avatarUrl: null,
        pendingInviteToken: 'b'.repeat(64),
      }),
    ).resolves.toMatchObject({
      builderId: 'builder-expand',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
      acceptedInviteId: 'invite-expand',
    });
  });

  it('discovers a valid invite by verified email without a bearer token', async () => {
    mocks.state.executeRows.push(
      [],
      [{ id: 'invite-email', builder_id: 'builder-invited', role: 'member' }],
    );
    mocks.state.selectRows.push(
      [],
      [
        {
          slug: 'invited-workspace',
          role: 'member',
          plan: 'scale',
          access_state: 'active',
          entitlement_source: 'stripe',
        },
      ],
    );

    await expect(
      findOrCreateBuilderForUser({
        userId: 'user-email-invited',
        email: 'Invitee@Example.com',
        displayName: 'Invitee',
        avatarUrl: null,
      }),
    ).resolves.toEqual({
      builderId: 'builder-invited',
      slug: 'invited-workspace',
      role: 'member',
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: 'invite-email',
    });

    expect(mocks.state.insertCalls.some((call) => call.table === 'builders')).toBe(false);
    expect(
      mocks.assertHostedProvisionalSignupEnabledTx,
    ).not.toHaveBeenCalled();
    expect(whereText(mocks.state.executeCalls[0])).toContain('pg_advisory_xact_lock');
    const claimSql = whereText(mocks.state.executeCalls[1]);
    expect(claimSql).toContain('created_at');
    expect(claimSql).toContain('desc');
    expect(claimSql).toContain('id');
    expect(claimSql).toContain('asc');
  });
});

describe('membership entitlement normalization', () => {
  beforeEach(() => {
    mocks.state.reset();
  });

  it('normalizes the sole legacy tuple when resolving a slug for middleware/cache use', async () => {
    mocks.state.selectRows.push([
      {
        builder_id: 'builder-legacy',
        role: 'member',
        plan: 'free',
        access_state: null,
        entitlement_source: null,
      },
    ]);

    await expect(
      resolveSlugForUser({ slug: 'legacy', userId: 'user-legacy' }),
    ).resolves.toEqual({
      builderId: 'builder-legacy',
      role: 'member',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
    });
  });

  it('returns no membership for a malformed slug entitlement tuple', async () => {
    mocks.state.selectRows.push([
      {
        builder_id: 'builder-invalid',
        role: 'member',
        plan: 'scale',
        access_state: 'suspended',
        entitlement_source: 'stripe',
      },
    ]);

    await expect(
      resolveSlugForUser({ slug: 'invalid', userId: 'user-invalid' }),
    ).resolves.toBeNull();
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
      { builder_id: 'builder-invalid', reason: 'invalid_combination' },
      'invalid persisted builder entitlement; auth access denied',
    );
  });

  it('normalizes the sole legacy tuple before switch-org session issuance', async () => {
    mocks.state.selectRows.push([
      {
        builder_id: 'builder-legacy',
        role: 'owner',
        slug: 'legacy',
        plan: 'free',
        access_state: null,
        entitlement_source: null,
      },
    ]);

    await expect(
      switchActiveOrg({ userId: 'user-legacy', builderId: 'builder-legacy' }),
    ).resolves.toMatchObject({
      builderId: 'builder-legacy',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
    });
  });

  it('returns no switch target for a malformed entitlement tuple', async () => {
    mocks.state.selectRows.push([
      {
        builder_id: 'builder-invalid',
        role: 'owner',
        slug: 'invalid',
        plan: null,
        access_state: 'active',
        entitlement_source: null,
      },
    ]);

    await expect(
      switchActiveOrg({ userId: 'user-invalid', builderId: 'builder-invalid' }),
    ).resolves.toBeNull();
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
      { builder_id: 'builder-invalid', reason: 'invalid_combination' },
      'invalid persisted builder entitlement; auth access denied',
    );
  });
});
