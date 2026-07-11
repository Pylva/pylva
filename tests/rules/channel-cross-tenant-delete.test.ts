// Cross-tenant rule-alert-channel deletion — unit regression for removeChannel.
//
// rule_alert_channels has NO builder_id column; its tenant boundary is the
// parent rule's builder_id. The app DB role does not enforce RLS (the
// tenant-isolation suite uses a separate NOBYPASSRLS role precisely because the
// app role bypasses it), so the explicit WHERE predicate is the only tenant
// lock. The DELETE route previously called:
//     removeChannel(ctx.builderId, channel_id)
// and removeChannel deleted by `eq(ruleAlertChannels.id, channelId)` alone, so
// an owner of builder A could delete builder B's alert channel by its row UUID
// (a client-exposed id), silently disabling B's budget/margin/threshold alerts.
//
// The fix scopes the delete to a rule the caller owns (ruleId from the path).
// This is a pure unit test (in-memory store standing in for the rules /
// rule_alert_channels tables) so it runs under the default `pnpm test`, unlike
// the DB-backed isolation suite under tests/security/** which only runs in the
// integration config.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUILDER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BUILDER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface RuleRow {
  id: string;
  builder_id: string;
}
interface ChannelRow {
  id: string;
  rule_id: string;
  channel?: 'webhook' | 'email' | 'slack';
  enabled?: boolean;
  webhook_config_id?: string | null;
  email_recipients?: string[] | null;
  slack_webhook_url?: string | null;
}
interface WebhookConfigRow {
  id: string;
  builder_id: string;
}

let rulesStore: RuleRow[] = [];
let channelsStore: ChannelRow[] = [];
let webhookConfigsStore: WebhookConfigRow[] = [];

type Cond =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'and'; conds: Cond[] }
  | { kind: 'exists'; tbl: { _t: string }; cond: Cond };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  switch (cond.kind) {
    case 'and':
      return cond.conds.every((c) => matches(row, c));
    case 'eq':
      return row[cond.col] === cond.val;
    case 'exists':
      return storeFor(cond.tbl).some((r) => matches(r, cond.cond));
  }
}

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

// Column descriptors carry their name; tables carry a `_t` tag so the mocked tx
// can route from()/delete() to the right in-memory store.
vi.mock('../../src/lib/db/schema.js', () => ({
  rules: {
    _t: 'rules',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
  },
  ruleAlertChannels: {
    _t: 'rule_alert_channels',
    id: { name: 'id' },
    rule_id: { name: 'rule_id' },
    channel: { name: 'channel' },
    enabled: { name: 'enabled' },
    webhook_config_id: { name: 'webhook_config_id' },
    email_recipients: { name: 'email_recipients' },
    slack_webhook_url: { name: 'slack_webhook_url' },
  },
  webhookConfigs: {
    _t: 'webhook_configs',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({
    kind: 'eq',
    col: col.name,
    val,
  }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
  exists: (query: { __tbl: { _t: string }; __cond: Cond }) => ({
    kind: 'exists',
    tbl: query.__tbl,
    cond: query.__cond,
  }),
  sql: () => ({ name: 'one' }),
  ne: () => ({ kind: 'ne' }),
  desc: () => ({ kind: 'desc' }),
}));

function storeFor(tbl: { _t: string }): Array<Record<string, unknown>> {
  if (tbl._t === 'rules') {
    return rulesStore as unknown as Array<Record<string, unknown>>;
  }
  if (tbl._t === 'webhook_configs') {
    return webhookConfigsStore as unknown as Array<Record<string, unknown>>;
  }
  return channelsStore as unknown as Array<Record<string, unknown>>;
}

function projectRow(
  row: Record<string, unknown>,
  projection?: Record<string, { name: string }>,
): Record<string, unknown> {
  if (!projection) return { ...row };
  return Object.fromEntries(Object.entries(projection).map(([key, col]) => [key, row[col.name]]));
}

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_b: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: (projection?: Record<string, { name: string }>) => ({
        from: (tbl: { _t: string }) => ({
          where: (cond: Cond) => {
            const rows = storeFor(tbl)
              .filter((r) => matches(r, cond))
              .map((r) => projectRow(r, projection));
            return Object.assign(Promise.resolve(rows), {
              __tbl: tbl,
              __cond: cond,
              limit: (n: number) => Promise.resolve(rows.slice(0, n)),
            });
          },
        }),
      }),
      insert: (tbl: { _t: string }) => ({
        values: (values: Record<string, unknown>) => ({
          returning: () => {
            const store = storeFor(tbl);
            const row = {
              id: `inserted-${store.length + 1}`,
              ...values,
            };
            store.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
      delete: (tbl: { _t: string }) => ({
        where: (cond: Cond) => ({
          returning: () => {
            const store = storeFor(tbl);
            const hit = store.filter((r) => matches(r, cond));
            for (const r of hit) store.splice(store.indexOf(r), 1);
            return Promise.resolve(hit.map((r) => ({ id: r['id'] })));
          },
        }),
      }),
    };
    return cb(tx);
  },
}));

const { addChannel, listChannelsForRule, removeChannel } =
  await import('../../src/lib/rules/repository.js');

describe('removeChannel — cross-tenant isolation', () => {
  beforeEach(() => {
    rulesStore = [
      { id: 'rule-A1', builder_id: BUILDER_A },
      { id: 'rule-B1', builder_id: BUILDER_B },
    ];
    channelsStore = [
      { id: 'chan-A', rule_id: 'rule-A1', channel: 'email', enabled: true },
      { id: 'chan-B', rule_id: 'rule-B1', channel: 'email', enabled: true },
    ];
    webhookConfigsStore = [
      { id: 'webhook-A', builder_id: BUILDER_A },
      { id: 'webhook-B', builder_id: BUILDER_B },
    ];
  });

  it("does not delete another tenant's channel passed under the caller's own rule id", async () => {
    // Attacker A owns rule-A1; targets B's channel by its (client-exposed) UUID.
    const ok = await removeChannel(BUILDER_A, 'rule-A1', 'chan-B');
    expect(ok).toBe(false);
    // BUG (pre-fix): chan-B was deleted, silencing builder B's alerts.
    expect(channelsStore.some((c) => c.id === 'chan-B')).toBe(true);
  });

  it('does not delete a channel when the path rule id belongs to another tenant', async () => {
    // Attacker A names B's rule directly.
    const ok = await removeChannel(BUILDER_A, 'rule-B1', 'chan-B');
    expect(ok).toBe(false);
    expect(channelsStore.some((c) => c.id === 'chan-B')).toBe(true);
  });

  it('deletes the caller’s own channel (same-tenant happy path)', async () => {
    const ok = await removeChannel(BUILDER_A, 'rule-A1', 'chan-A');
    expect(ok).toBe(true);
    expect(channelsStore.some((c) => c.id === 'chan-A')).toBe(false);
    // Untouched: B's channel survives.
    expect(channelsStore.some((c) => c.id === 'chan-B')).toBe(true);
  });

  it('returns false for an unknown channel id on an owned rule', async () => {
    const ok = await removeChannel(BUILDER_A, 'rule-A1', 'chan-does-not-exist');
    expect(ok).toBe(false);
  });

  it('returns no channels for a foreign rule id', async () => {
    const channels = await listChannelsForRule(BUILDER_A, 'rule-B1');
    expect(channels).toEqual([]);
  });

  it("lists channels for the caller's own rule", async () => {
    const channels = await listChannelsForRule(BUILDER_A, 'rule-A1');
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: 'chan-A', rule_id: 'rule-A1' });
  });

  it("adds an email channel to the caller's own rule", async () => {
    const created = await addChannel(BUILDER_A, {
      rule_id: 'rule-A1',
      channel: 'email',
      email_recipients: ['alerts@example.com'],
    });

    expect(created).toMatchObject({
      rule_id: 'rule-A1',
      channel: 'email',
      email_recipients: ['alerts@example.com'],
    });
    expect(channelsStore.some((c) => c.id === created?.id)).toBe(true);
  });

  it('does not add a channel to a foreign rule id', async () => {
    const before = channelsStore.length;
    const created = await addChannel(BUILDER_A, {
      rule_id: 'rule-B1',
      channel: 'email',
      email_recipients: ['alerts@example.com'],
    });

    expect(created).toBeNull();
    expect(channelsStore).toHaveLength(before);
  });

  it("does not add a webhook channel that references another tenant's webhook config", async () => {
    const before = channelsStore.length;
    const created = await addChannel(BUILDER_A, {
      rule_id: 'rule-A1',
      channel: 'webhook',
      webhook_config_id: 'webhook-B',
    });

    expect(created).toBeNull();
    expect(channelsStore).toHaveLength(before);
  });

  it("adds a webhook channel with the caller's own webhook config", async () => {
    const created = await addChannel(BUILDER_A, {
      rule_id: 'rule-A1',
      channel: 'webhook',
      webhook_config_id: 'webhook-A',
    });

    expect(created).toMatchObject({
      rule_id: 'rule-A1',
      channel: 'webhook',
      webhook_config_id: 'webhook-A',
    });
    expect(channelsStore.some((c) => c.id === created?.id)).toBe(true);
  });
});
