import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    whereCalls: [] as Array<{
      kind: 'select' | 'delete';
      table: unknown;
      clause: unknown;
    }>,
    insertCalls: [] as Array<{ table: unknown; values: unknown }>,
    selectRows: [] as unknown[][],
    insertRows: [] as unknown[],
    deleteRows: [] as unknown[],
  };

  const nextSelectRows = () => state.selectRows.shift() ?? [];

  const tx = {
    select: (fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (clause: unknown) => {
          const query = {
            fields,
            table,
            clause,
            limit: () => Promise.resolve(nextSelectRows()),
            then: (resolve: (value: unknown[]) => unknown, reject: (reason?: unknown) => unknown) =>
              Promise.resolve(nextSelectRows()).then(resolve, reject),
          };
          state.whereCalls.push({ kind: 'select', table, clause });
          return query;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        state.insertCalls.push({ table, values });
        return {
          returning: () => Promise.resolve(state.insertRows),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: (clause: unknown) => {
        state.whereCalls.push({ kind: 'delete', table, clause });
        return {
          returning: () => Promise.resolve(state.deleteRows),
        };
      },
    }),
  };

  return {
    state,
    tx,
    withRLS: vi.fn(async (_builderId: string, cb: (txArg: unknown) => Promise<unknown>) => cb(tx)),
  };
});

vi.mock('drizzle-orm', () => ({
  and: (...clauses: unknown[]) => ({ op: 'and', clauses }),
  desc: (column: unknown) => ({ op: 'desc', column }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  exists: (query: unknown) => ({ op: 'exists', query }),
  ne: (left: unknown, right: unknown) => ({ op: 'ne', left, right }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    strings: Array.from(strings),
    values,
  }),
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  rules: {
    id: 'rules.id',
    builder_id: 'rules.builder_id',
  },
  ruleAlertChannels: {
    id: 'rule_alert_channels.id',
    rule_id: 'rule_alert_channels.rule_id',
    channel: 'rule_alert_channels.channel',
    enabled: 'rule_alert_channels.enabled',
    webhook_config_id: 'rule_alert_channels.webhook_config_id',
    email_recipients: 'rule_alert_channels.email_recipients',
    slack_webhook_url: 'rule_alert_channels.slack_webhook_url',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn() }),
  },
}));

const repo = await import('../../src/lib/rules/repository.js');

function resetMocks() {
  mocks.state.whereCalls.length = 0;
  mocks.state.insertCalls.length = 0;
  mocks.state.selectRows = [];
  mocks.state.insertRows = [];
  mocks.state.deleteRows = [];
  mocks.withRLS.mockClear();
}

function parentRulePredicate(builderId = 'builder-A', ruleId = 'rule-A') {
  return {
    op: 'and',
    clauses: [
      { op: 'eq', left: 'rules.id', right: ruleId },
      { op: 'eq', left: 'rules.builder_id', right: builderId },
    ],
  };
}

function expectParentExistsPredicate(clause: unknown) {
  expect(clause).toEqual({
    op: 'exists',
    query: expect.objectContaining({
      table: expect.objectContaining({
        id: 'rules.id',
        builder_id: 'rules.builder_id',
      }),
      clause: parentRulePredicate(),
    }),
  });
}

describe('rule channel repository tenant scoping', () => {
  beforeEach(resetMocks);

  it('removeChannel scopes by channel id, path rule id, and parent builder ownership', async () => {
    mocks.state.deleteRows = [{ id: 'channel-A' }];

    const result = await repo.removeChannel('builder-A', 'rule-A', 'channel-A');

    expect(result).toBe(true);
    expect(mocks.withRLS).toHaveBeenCalledWith('builder-A', expect.any(Function));
    const deleteCall = mocks.state.whereCalls.find((call) => call.kind === 'delete');
    expect(deleteCall?.clause).toEqual({
      op: 'and',
      clauses: [
        { op: 'eq', left: 'rule_alert_channels.id', right: 'channel-A' },
        { op: 'eq', left: 'rule_alert_channels.rule_id', right: 'rule-A' },
        expect.anything(),
      ],
    });
    expectParentExistsPredicate((deleteCall?.clause as { clauses: unknown[] }).clauses[2]);
  });

  it('removeChannel returns false when the scoped delete affects no rows', async () => {
    mocks.state.deleteRows = [];

    await expect(repo.removeChannel('builder-A', 'rule-A', 'missing-channel')).resolves.toBe(false);
  });

  it('listChannelsForRule includes the parent builder ownership predicate', async () => {
    mocks.state.selectRows = [[{ id: 'channel-A', rule_id: 'rule-A' }]];

    const rows = await repo.listChannelsForRule('builder-A', 'rule-A');

    expect(rows).toEqual([{ id: 'channel-A', rule_id: 'rule-A' }]);
    const listCall = mocks.state.whereCalls.find(
      (call) =>
        call.kind === 'select' &&
        (call.clause as { clauses?: Array<{ left?: unknown }> }).clauses?.[0]?.left ===
          'rule_alert_channels.rule_id',
    );
    expect(listCall?.clause).toEqual({
      op: 'and',
      clauses: [
        { op: 'eq', left: 'rule_alert_channels.rule_id', right: 'rule-A' },
        expect.anything(),
      ],
    });
    expectParentExistsPredicate((listCall?.clause as { clauses: unknown[] }).clauses[1]);
  });

  it('addChannel does not insert when the parent rule is not owned by the builder', async () => {
    mocks.state.selectRows = [[]];

    const result = await repo.addChannel('builder-A', {
      rule_id: 'rule-A',
      channel: 'slack',
      slack_webhook_url: 'https://hooks.slack.com/services/test',
    });

    expect(result).toBeNull();
    expect(mocks.state.insertCalls).toEqual([]);
  });

  it('addChannel inserts and returns the channel when the parent rule is owned by the builder', async () => {
    const channel = { id: 'channel-A', rule_id: 'rule-A' };
    mocks.state.selectRows = [[{ id: 'rule-A' }]];
    mocks.state.insertRows = [channel];

    const result = await repo.addChannel('builder-A', {
      rule_id: 'rule-A',
      channel: 'slack',
      slack_webhook_url: 'https://hooks.slack.com/services/test',
    });

    expect(result).toEqual(channel);
    expect(mocks.state.insertCalls).toEqual([
      {
        table: expect.objectContaining({
          id: 'rule_alert_channels.id',
          rule_id: 'rule_alert_channels.rule_id',
        }),
        values: expect.objectContaining({
          rule_id: 'rule-A',
          channel: 'slack',
          slack_webhook_url: 'https://hooks.slack.com/services/test',
        }),
      },
    ]);
  });
});
