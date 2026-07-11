// Regression test: GET /api/v1/alerts/dlq must apply the channel /
// event_type filters in SQL (inside the WHERE clause), BEFORE the 200-row
// cap — not in JS after the rows have already been truncated.
//
// The buggy version selected the newest 200 rows across ALL channels and
// only then filtered in JS. A builder with >200 failed webhook deliveries
// (newer than its slack/email failures) would get an EMPTY response for
// `?channel=slack` even though slack DLQ entries exist — dead alerts
// silently dropped from the operator's retry surface.
//
// The fake `tx` below models real SQL semantics (filter → order → limit),
// so the assertion is sensitive to WHERE the filter runs: keep the JS
// post-limit filter and the slack rows vanish; push the filter into the
// query and they come back.

import { describe, it, expect, vi } from 'vitest';

// Inspectable predicate builders so the fake tx can interpret the WHERE
// clause. The route only uses eq/and/desc from drizzle-orm.
vi.mock('drizzle-orm', () => ({
  eq: (col: { name?: string }, val: unknown) => ({ __op: 'eq', name: col?.name, val }),
  and: (...conds: unknown[]) => ({ __op: 'and', conds: conds.filter(Boolean) }),
  desc: (col: { name?: string }) => ({ __op: 'desc', name: col?.name }),
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: BUILDER_ID,
    userId: 'u-1',
    role: 'owner',
  }),
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  webhookDlq: {
    id: { name: 'id' },
    channel: { name: 'channel' },
    event_type: { name: 'event_type' },
    webhook_config_id: { name: 'webhook_config_id' },
    attempts: { name: 'attempts' },
    last_attempt_at: { name: 'last_attempt_at' },
    last_error: { name: 'last_error' },
    created_at: { name: 'created_at' },
    builder_id: { name: 'builder_id' },
  },
}));

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';

interface Row {
  id: string;
  channel: string;
  event_type: string;
  webhook_config_id: string | null;
  attempts: number;
  last_attempt_at: Date | null;
  last_error: string | null;
  created_at: Date;
  builder_id: string;
}

const store: Row[] = [];

function matches(row: Row, cond: unknown): boolean {
  if (!cond || typeof cond !== 'object') return true;
  const c = cond as { __op?: string; conds?: unknown[]; name?: string; val?: unknown };
  if (c.__op === 'and') return (c.conds ?? []).every((sub) => matches(row, sub));
  if (c.__op === 'eq') return (row as unknown as Record<string, unknown>)[c.name!] === c.val;
  return true;
}

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: async (_b: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      select: () => ({
        from: () => ({
          // Faithful SQL semantics: filter by WHERE, order by created_at
          // desc, THEN apply the row limit.
          where: (clause: unknown) => {
            const filtered = store
              .filter((r) => matches(r, clause))
              .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
            return {
              orderBy: () => ({
                limit: (n: number) => Promise.resolve(filtered.slice(0, n)),
              }),
            };
          },
        }),
      }),
    }),
}));

const { GET } = await import('../../src/app/api/v1/alerts/dlq/route.js');

function seed(): void {
  store.length = 0;
  const base = Date.UTC(2026, 5, 1, 0, 0, 0);
  // 5 slack failures — the OLDEST rows.
  for (let i = 0; i < 5; i++) {
    store.push(makeRow(`slack-${i}`, 'slack', new Date(base + i * 1000)));
  }
  // 250 webhook failures — all NEWER than every slack row, so they fill
  // the entire newest-200 window on their own.
  for (let i = 0; i < 250; i++) {
    store.push(makeRow(`wh-${i}`, 'webhook', new Date(base + 1_000_000 + i * 1000)));
  }
}

function makeRow(id: string, channel: string, created_at: Date): Row {
  return {
    id,
    channel,
    event_type: 'rule.fired',
    webhook_config_id: channel === 'webhook' ? 'cfg-1' : null,
    attempts: 4,
    last_attempt_at: created_at,
    last_error: 'boom',
    created_at,
    builder_id: BUILDER_ID,
  };
}

function call(query: string): Promise<{ entries: Row[] }> {
  const req = { url: `http://localhost/api/v1/alerts/dlq${query}` } as unknown as Parameters<
    typeof GET
  >[0];
  return GET(req).then((res) => res.json());
}

describe('GET /api/v1/alerts/dlq — filter is applied before the row cap', () => {
  it('returns slack entries even when 250 newer webhook failures exist', async () => {
    seed();
    const { entries } = await call('?channel=slack');
    // All 5 slack rows must surface. The buggy filter-after-limit code
    // returns [] here because the newest 200 rows are all webhooks.
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.channel === 'slack')).toBe(true);
  });

  it('filters by event_type before the cap too', async () => {
    seed();
    store.push(makeRow('rare-1', 'email', new Date(Date.UTC(2026, 5, 1, 0, 0, 1))));
    store[store.length - 1]!.event_type = 'anomaly.detected';
    const { entries } = await call('?event_type=anomaly.detected');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('rare-1');
  });

  it('unfiltered list still returns the newest 200 rows', async () => {
    seed();
    const { entries } = await call('');
    expect(entries).toHaveLength(200);
  });

  it('never lists failed deliveries from another builder', async () => {
    seed();
    store.push({
      ...makeRow('foreign-1', 'slack', new Date(Date.UTC(2026, 5, 2, 0, 0, 0))),
      builder_id: '00000000-0000-0000-0000-000000000002',
    });

    const { entries } = await call('?channel=slack');

    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.builder_id === BUILDER_ID)).toBe(true);
    expect(entries.some((e) => e.id === 'foreign-1')).toBe(false);
  });
});
