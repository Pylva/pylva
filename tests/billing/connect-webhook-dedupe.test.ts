import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  const ACCOUNT_ID = 'acct_test_connect';
  const BUILDER_ID = '00000000-0000-0000-0000-000000000001';

  interface ColumnDesc {
    name: string;
  }

  interface TableDesc {
    __table: string;
  }

  interface StripeConnectRow {
    stripe_account_id: string;
    builder_id: string;
  }

  interface EventLogRow {
    stripe_account_id: string;
    stripe_event_id: string;
    type: string;
    builder_id: string | null;
    received_at: Date;
    processing_started_at: Date | null;
    handled_at: Date | null;
    last_error: string | null;
  }

  type Fields = Record<string, ColumnDesc>;
  type RowRecord = Record<string, unknown>;
  type Cond =
    | { kind: 'eq'; col: string; val: unknown }
    | { kind: 'isNull'; col: string }
    | { kind: 'lt'; col: string; val: Date }
    | { kind: 'and'; conds: Cond[] }
    | { kind: 'or'; conds: Cond[] };

  const col = (name: string): ColumnDesc => ({ name });
  const stripeConnect = {
    __table: 'stripe_connect',
    stripe_account_id: col('stripe_account_id'),
    builder_id: col('builder_id'),
  };
  const stripeConnectEventLog = {
    __table: 'stripe_connect_event_log',
    stripe_account_id: col('stripe_account_id'),
    stripe_event_id: col('stripe_event_id'),
    type: col('type'),
    builder_id: col('builder_id'),
    received_at: col('received_at'),
    processing_started_at: col('processing_started_at'),
    handled_at: col('handled_at'),
    last_error: col('last_error'),
  };

  let connectRows: StripeConnectRow[] = [];
  const eventRows = new Map<string, EventLogRow>();
  let currentEvent: unknown;

  const dispatchSpy = vi.fn();
  const constructEventSpy = vi.fn(() => currentEvent);
  const warnSpy = vi.fn();

  function eventKey(accountId: string, eventId: string): string {
    return `${accountId}:${eventId}`;
  }

  function asRecord(row: unknown): RowRecord {
    return row as RowRecord;
  }

  function matches(row: RowRecord, cond: Cond): boolean {
    switch (cond.kind) {
      case 'and':
        return cond.conds.every((c) => matches(row, c));
      case 'or':
        return cond.conds.some((c) => matches(row, c));
      case 'eq':
        return row[cond.col] === cond.val;
      case 'isNull':
        return row[cond.col] == null;
      case 'lt': {
        const raw = row[cond.col];
        const d = raw instanceof Date ? raw : raw ? new Date(String(raw)) : null;
        return Boolean(d && d.getTime() < cond.val.getTime());
      }
    }
  }

  function rowsFor(table: TableDesc): RowRecord[] {
    if (table.__table === 'stripe_connect') {
      return connectRows.map(asRecord);
    }
    if (table.__table === 'stripe_connect_event_log') {
      return Array.from(eventRows.values()).map(asRecord);
    }
    return [];
  }

  function project(row: RowRecord, fields: Fields): RowRecord {
    const out: RowRecord = {};
    for (const [alias, desc] of Object.entries(fields)) {
      out[alias] = row[desc.name];
    }
    return out;
  }

  function insertEventLog(vals: Partial<EventLogRow>): EventLogRow | null {
    const row: EventLogRow = {
      stripe_account_id: String(vals.stripe_account_id),
      stripe_event_id: String(vals.stripe_event_id),
      type: String(vals.type),
      builder_id: vals.builder_id ?? null,
      received_at: vals.received_at ?? new Date(),
      processing_started_at: vals.processing_started_at ?? null,
      handled_at: vals.handled_at ?? null,
      last_error: vals.last_error ?? null,
    };
    const key = eventKey(row.stripe_account_id, row.stripe_event_id);
    if (eventRows.has(key)) return null;
    eventRows.set(key, row);
    return row;
  }

  const db = {
    insert: (table: TableDesc) => ({
      values: (vals: Partial<EventLogRow>) => ({
        onConflictDoNothing: () => ({
          returning: (fields: Fields) => {
            if (table.__table !== 'stripe_connect_event_log') return Promise.resolve([]);
            const row = insertEventLog(vals);
            return Promise.resolve(row ? [project(asRecord(row), fields)] : []);
          },
        }),
      }),
    }),
    select: (fields: Fields) => ({
      from: (table: TableDesc) => ({
        where: (cond: Cond) => ({
          limit: (n: number) =>
            Promise.resolve(
              rowsFor(table)
                .filter((row) => matches(row, cond))
                .slice(0, n)
                .map((row) => project(row, fields)),
            ),
        }),
      }),
    }),
    update: (table: TableDesc) => ({
      set: (vals: Partial<EventLogRow>) => ({
        where: (cond: Cond) => ({
          returning: (fields: Fields) => {
            const hit = rowsFor(table).filter((row) => matches(row, cond));
            for (const row of hit) Object.assign(row, vals);
            return Promise.resolve(hit.map((row) => project(row, fields)));
          },
        }),
      }),
    }),
  };

  function makeEvent(id: string, type = 'charge.dispute.created') {
    return {
      id,
      type,
      account: ACCOUNT_ID,
      created: 100,
      data: { object: { id: 'dp_test_1' } },
    };
  }

  function reset(): void {
    connectRows = [{ stripe_account_id: ACCOUNT_ID, builder_id: BUILDER_ID }];
    eventRows.clear();
    currentEvent = makeEvent('evt_default');
    dispatchSpy.mockReset();
    constructEventSpy.mockClear();
  }

  function setCurrentEvent(event: unknown): void {
    currentEvent = event;
  }

  function putEventRow(row: EventLogRow): void {
    eventRows.set(eventKey(row.stripe_account_id, row.stripe_event_id), row);
  }

  function getEventRow(eventId: string): EventLogRow | undefined {
    return eventRows.get(eventKey(ACCOUNT_ID, eventId));
  }

  function deleteEventRow(eventId: string): void {
    eventRows.delete(eventKey(ACCOUNT_ID, eventId));
  }

  return {
    ACCOUNT_ID,
    BUILDER_ID,
    db,
    dispatchSpy,
    constructEventSpy,
    warnSpy,
    makeEvent,
    reset,
    setCurrentEvent,
    putEventRow,
    getEventRow,
    deleteEventRow,
    stripeConnect,
    stripeConnectEventLog,
  };
});

vi.mock('../../src/lib/config.js', () => ({
  env: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_API_VERSION: '2024-11-20.acacia',
    STRIPE_SECRET_KEY: 'sk_test',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => undefined,
      warn: mockState.warnSpy,
      error: () => undefined,
    }),
  },
}));

vi.mock('../../src/lib/db/client.js', () => ({ db: mockState.db }));

vi.mock('../../src/lib/db/schema.js', () => ({
  stripeConnect: mockState.stripeConnect,
  stripeConnectEventLog: mockState.stripeConnectEventLog,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  isNull: (col: { name: string }) => ({ kind: 'isNull', col: col.name }),
  lt: (col: { name: string }, val: Date) => ({ kind: 'lt', col: col.name, val }),
  and: (...conds: unknown[]) => ({ kind: 'and', conds }),
  or: (...conds: unknown[]) => ({ kind: 'or', conds }),
}));

vi.mock('../../src/lib/stripe/client.js', () => ({
  stripeFor: () => ({
    webhooks: {
      constructEvent: mockState.constructEventSpy,
    },
  }),
}));

vi.mock('../../src/lib/stripe/webhook-handlers.js', () => ({
  dispatch: mockState.dispatchSpy,
}));

const { handleConnectStripeWebhook } =
  await import('../../src/lib/stripe/connect-webhook-public-handler.js');

async function postWebhook() {
  return handleConnectStripeWebhook({
    rawBody: '{}',
    signature: 't=0,v1=test',
  });
}

describe('Connect webhook route event-id dedupe', () => {
  beforeEach(() => {
    mockState.reset();
    mockState.warnSpy.mockReset();
  });

  it('acks a handled duplicate without dispatching', async () => {
    const event = mockState.makeEvent('evt_handled');
    mockState.setCurrentEvent(event);
    mockState.putEventRow({
      stripe_account_id: mockState.ACCOUNT_ID,
      stripe_event_id: 'evt_handled',
      type: event.type,
      builder_id: mockState.BUILDER_ID,
      received_at: new Date(Date.now() - 10 * 60 * 1000),
      processing_started_at: null,
      handled_at: new Date(),
      last_error: null,
    });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(mockState.dispatchSpy).not.toHaveBeenCalled();
  });

  it('reclaims a stale unhandled row and dispatches', async () => {
    const event = mockState.makeEvent('evt_stale');
    mockState.setCurrentEvent(event);
    mockState.putEventRow({
      stripe_account_id: mockState.ACCOUNT_ID,
      stripe_event_id: 'evt_stale',
      type: event.type,
      builder_id: mockState.BUILDER_ID,
      received_at: new Date(Date.now() - 10 * 60 * 1000),
      processing_started_at: new Date(Date.now() - 10 * 60 * 1000),
      handled_at: null,
      last_error: null,
    });
    mockState.dispatchSpy.mockResolvedValueOnce(undefined);

    const res = await postWebhook();
    const row = mockState.getEventRow('evt_stale');

    expect(res.status).toBe(200);
    expect(mockState.dispatchSpy).toHaveBeenCalledTimes(1);
    expect(row?.handled_at).toBeInstanceOf(Date);
    expect(row?.processing_started_at).toBeNull();
    expect(row?.last_error).toBeNull();
  });

  it('returns non-2xx for a recent in-progress duplicate without dispatching', async () => {
    const event = mockState.makeEvent('evt_busy');
    mockState.setCurrentEvent(event);
    mockState.putEventRow({
      stripe_account_id: mockState.ACCOUNT_ID,
      stripe_event_id: 'evt_busy',
      type: event.type,
      builder_id: mockState.BUILDER_ID,
      received_at: new Date(),
      processing_started_at: new Date(),
      handled_at: null,
      last_error: null,
    });

    const res = await postWebhook();

    expect(res.status).toBe(503);
    expect(res.headers?.['Retry-After']).toBe('30');
    expect(mockState.dispatchSpy).not.toHaveBeenCalled();
  });

  it('leaves handled_at null and clears processing on handler error', async () => {
    const event = mockState.makeEvent('evt_error');
    mockState.setCurrentEvent(event);
    mockState.dispatchSpy.mockRejectedValueOnce(new Error('simulated handler failure'));

    const res = await postWebhook();
    const row = mockState.getEventRow('evt_error');

    expect(res.status).toBe(500);
    expect(row?.handled_at).toBeNull();
    expect(row?.processing_started_at).toBeNull();
    expect(row?.last_error).toBe('simulated handler failure');
  });

  it('does not dispatch a replayed dispute twice', async () => {
    const event = mockState.makeEvent('evt_dispute');
    mockState.setCurrentEvent(event);
    mockState.dispatchSpy.mockResolvedValue(undefined);

    const first = await postWebhook();
    const second = await postWebhook();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockState.dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('warns when the handled marker update matches zero rows', async () => {
    const event = mockState.makeEvent('evt_missing_handled');
    mockState.setCurrentEvent(event);
    mockState.dispatchSpy.mockImplementationOnce(async () => {
      mockState.deleteEventRow('evt_missing_handled');
    });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(mockState.warnSpy).toHaveBeenCalledWith(
      { account: mockState.ACCOUNT_ID, event_id: 'evt_missing_handled' },
      'markConnectEventHandled matched 0 rows - row missing or already handled',
    );
  });

  it('warns when the failed marker update matches zero rows', async () => {
    const event = mockState.makeEvent('evt_missing_failed');
    mockState.setCurrentEvent(event);
    mockState.dispatchSpy.mockImplementationOnce(async () => {
      mockState.deleteEventRow('evt_missing_failed');
      throw new Error('simulated handler failure');
    });

    const res = await postWebhook();

    expect(res.status).toBe(500);
    expect(mockState.warnSpy).toHaveBeenCalledWith(
      { account: mockState.ACCOUNT_ID, event_id: 'evt_missing_failed' },
      'markConnectEventFailed matched 0 rows - row missing or already handled',
    );
  });
});
