import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

import type {
  BudgetProjectionInspection,
  BudgetProjectionTarget,
} from '../../src/lib/budget-projection/clickhouse.js';
import {
  __budgetProjectionPostgresTesting,
  createBudgetProjectionWorkerId,
  type BudgetProjectionPostgresStore,
  type BudgetProjectionReconciliationItem,
} from '../../src/lib/budget-projection/postgres.js';
import {
  __budgetProjectionWorkerTesting,
  budgetProjectionRunFailedSystemically,
  runBudgetCostEventProjection,
} from '../../src/lib/budget-projection/worker.js';
import {
  BUILDER_ID,
  EVENT_ID,
  OUTBOX_ID,
  PAYLOAD_HASH,
  WORKER_ID,
  projectionLease,
  projectionStatus,
  toolPayload,
} from './fixtures.js';

function mockStore(overrides: Partial<BudgetProjectionPostgresStore> = {}) {
  const store: BudgetProjectionPostgresStore = {
    listBuilderPage: vi.fn(async () => []),
    recoverExpiredLeases: vi.fn(async () => 0),
    claim: vi.fn(async () => []),
    renew: vi.fn(async (lease) => ({ ...lease, lock_expires_at: '2026-07-14T09:12:12.000Z' })),
    releaseForRetry: vi.fn(async () => true),
    markProjected: vi.fn(async () => true),
    listReconciliationItems: vi.fn(async () => []),
    markVerified: vi.fn(async () => true),
    status: vi.fn(async () => projectionStatus()),
    isVerifiedBefore: vi.fn(async () => true),
    billingGate: vi.fn(async () => ({ closed: true, verified: true })),
    ...overrides,
  };
  return store;
}

function mockTarget(inspections: BudgetProjectionInspection[] = []) {
  let cursor = 0;
  const target: BudgetProjectionTarget = {
    insert: vi.fn(async () => undefined),
    inspect: vi.fn(async () => inspections[cursor++] ?? inspections.at(-1)!),
  };
  return target;
}

const missing: BudgetProjectionInspection = {
  state: 'missing',
  physical_rows: 0,
  logical_rows: 0,
  hashes: [],
};
const matched: BudgetProjectionInspection = {
  state: 'matched',
  physical_rows: 1,
  logical_rows: 1,
  hashes: [PAYLOAD_HASH],
};
const conflict: BudgetProjectionInspection = {
  state: 'conflict',
  physical_rows: 2,
  logical_rows: 1,
  hashes: [PAYLOAD_HASH, 'b'.repeat(64)],
};

describe('authoritative budget projection lease processing', () => {
  it('inserts, renews around each network boundary, verifies, and projects', async () => {
    const store = mockStore();
    const target = mockTarget([missing, matched]);
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, target, projectionLease()),
    ).resolves.toBe('projected');
    expect(target.insert).toHaveBeenCalledOnce();
    expect(store.renew).toHaveBeenCalledTimes(3);
    expect(store.markProjected).toHaveBeenCalledOnce();
    expect(store.releaseForRetry).not.toHaveBeenCalled();
  });

  it('recovers an event already present before insertion without duplicating it', async () => {
    const store = mockStore();
    const target = mockTarget([matched]);
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, target, projectionLease()),
    ).resolves.toBe('already_present');
    expect(target.insert).not.toHaveBeenCalled();
    expect(store.markProjected).toHaveBeenCalledOnce();
  });

  it('recovers a lost acknowledgement when verification finds the inserted event', async () => {
    const store = mockStore();
    const target = mockTarget([missing, matched]);
    vi.mocked(target.insert).mockRejectedValueOnce(new Error('secret=https://clickhouse.invalid'));
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, target, projectionLease()),
    ).resolves.toBe('lost_ack_recovered');
    expect(store.markProjected).toHaveBeenCalledOnce();
    expect(store.releaseForRetry).not.toHaveBeenCalled();
  });

  it('never inserts over an event identity with conflicting physical hashes', async () => {
    const store = mockStore();
    const target = mockTarget([conflict]);
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, target, projectionLease()),
    ).resolves.toBe('conflict');
    expect(target.insert).not.toHaveBeenCalled();
    expect(store.releaseForRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 'PROJECTION_HASH_CONFLICT' }),
    );
  });

  it('retries a synchronous insert that remains invisible', async () => {
    const store = mockStore();
    const target = mockTarget([missing, missing]);
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, target, projectionLease()),
    ).resolves.toBe('retry');
    expect(store.releaseForRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 'PROJECTION_NOT_VISIBLE' }),
    );
  });

  it('retries when the initial inspection is unavailable and does not risk a blind insert', async () => {
    const store = mockStore();
    const target = mockTarget();
    vi.mocked(target.inspect).mockRejectedValueOnce(new Error('ECONNREFUSED token=secret'));
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, target, projectionLease()),
    ).resolves.toBe('retry');
    expect(target.insert).not.toHaveBeenCalled();
    const failure = vi.mocked(store.releaseForRetry).mock.calls[0]?.[1];
    expect(failure).toMatchObject({ code: 'PROJECTION_INSPECTION_FAILED' });
    expect(failure?.message).not.toContain('secret');
    expect(failure?.message).not.toContain('ECONNREFUSED');
  });

  it('retries an invalid immutable payload without calling ClickHouse', async () => {
    const store = mockStore();
    const target = mockTarget();
    const lease = projectionLease({ payload: { ...toolPayload(), prompt: 'private' } });
    await expect(__budgetProjectionWorkerTesting.processLease(store, target, lease)).resolves.toBe(
      'invalid',
    );
    expect(target.inspect).not.toHaveBeenCalled();
    expect(target.insert).not.toHaveBeenCalled();
    expect(store.releaseForRetry).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ code: 'PROJECTION_PAYLOAD_INVALID' }),
    );
  });

  it.each([
    ['prompt', () => ({ ...toolPayload().metadata, prompt: 'private' })],
    ['messages', () => ({ ...toolPayload().metadata, messages: [{ role: 'user' }] })],
    ['tool arguments', () => ({ ...toolPayload().metadata, tool_arguments: { query: 'private' } })],
    ['content', () => ({ ...toolPayload().metadata, content: 'private' })],
    ['unknown key', () => ({ ...toolPayload().metadata, extra: 'private' })],
    ['nested value', () => ({ ...toolPayload().metadata, finish_reason: { value: 'private' } })],
    [
      'cyclic value',
      () => {
        const cyclic: Record<string, unknown> = { ...toolPayload().metadata };
        cyclic['finish_reason'] = cyclic;
        return cyclic;
      },
    ],
    ['undefined value', () => ({ ...toolPayload().metadata, finish_reason: undefined })],
    ['bigint value', () => ({ ...toolPayload().metadata, finish_reason: 1n })],
    ['function value', () => ({ ...toolPayload().metadata, finish_reason: () => 'private' })],
  ])('rejects %s metadata before any ClickHouse call', async (_label, makeMetadata) => {
    const store = mockStore();
    const target = mockTarget();
    const lease = projectionLease({
      payload: toolPayload({ metadata: makeMetadata() as never }),
    });

    await expect(__budgetProjectionWorkerTesting.processLease(store, target, lease)).resolves.toBe(
      'invalid',
    );
    expect(target.inspect).not.toHaveBeenCalled();
    expect(target.insert).not.toHaveBeenCalled();
    expect(store.releaseForRetry).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ code: 'PROJECTION_PAYLOAD_INVALID' }),
    );
  });

  it.each([
    { label: 'renewal', store: mockStore({ renew: vi.fn(async () => null) }) },
    { label: 'finalize', store: mockStore({ markProjected: vi.fn(async () => false) }) },
  ])('reports a lost lease at $label fencing', async ({ store }) => {
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, mockTarget([matched]), projectionLease()),
    ).resolves.toBe('lease_lost');
  });

  it('reports a lost lease when a retry release no longer owns the expected attempt', async () => {
    const store = mockStore({ releaseForRetry: vi.fn(async () => false) });
    const target = mockTarget();
    vi.mocked(target.inspect).mockRejectedValueOnce(new Error('down'));
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, target, projectionLease()),
    ).resolves.toBe('lease_lost');
  });
});

describe('authoritative budget projection reconciliation', () => {
  const item: BudgetProjectionReconciliationItem = {
    builder_id: BUILDER_ID,
    outbox_id: OUTBOX_ID,
    event_id: EVENT_ID,
    payload_hash: PAYLOAD_HASH,
  };

  it('marks only a hash-matched FINAL event verified', async () => {
    const store = mockStore();
    await expect(
      __budgetProjectionWorkerTesting.reconcileItem(store, mockTarget([matched]), item),
    ).resolves.toBe('verified');
    expect(store.markVerified).toHaveBeenCalledWith(item);
  });

  it.each([
    [missing, 'missing'],
    [conflict, 'conflict'],
  ] as const)('leaves a %s projection unverified', async (inspection, expected) => {
    const store = mockStore();
    await expect(
      __budgetProjectionWorkerTesting.reconcileItem(store, mockTarget([inspection]), item),
    ).resolves.toBe(expected);
    expect(store.markVerified).not.toHaveBeenCalled();
  });

  it('keeps the row unverified when ClickHouse or PostgreSQL fails', async () => {
    const target = mockTarget();
    vi.mocked(target.inspect).mockRejectedValueOnce(new Error('down'));
    await expect(
      __budgetProjectionWorkerTesting.reconcileItem(mockStore(), target, item),
    ).resolves.toBe('error');
    await expect(
      __budgetProjectionWorkerTesting.reconcileItem(
        mockStore({ markVerified: vi.fn(async () => false) }),
        mockTarget([matched]),
        item,
      ),
    ).resolves.toBe('error');
  });

  it('rotates the bounded reconciliation page so a persistent early gap cannot starve later rows', async () => {
    const early = { ...item, outbox_id: '11111111-1111-4111-8111-111111111111' };
    const late = { ...item, outbox_id: '99999999-9999-4999-8999-999999999999' };
    const listReconciliationItems = vi.fn(
      async (_builderId: string, after: string | null, limit: number) =>
        (after === null ? [early, late] : [late]).slice(0, limit),
    );
    const rows = await __budgetProjectionWorkerTesting.listFairReconciliationItems(
      mockStore({ listReconciliationItems }),
      BUILDER_ID,
      WORKER_ID,
      2,
    );
    expect(rows.map((row) => row.outbox_id)).toEqual([late.outbox_id, early.outbox_id]);
    expect(listReconciliationItems).toHaveBeenNthCalledWith(
      1,
      BUILDER_ID,
      '88888888-8888-4888-8888-888888888888',
      2,
    );
    expect(listReconciliationItems).toHaveBeenNthCalledWith(2, BUILDER_ID, null, 1);
  });
});

describe('authoritative budget projection runner and safety helpers', () => {
  it('creates a globally unique worker incarnation identity and rejects invalid generators', () => {
    const first = createBudgetProjectionWorkerId();
    const second = createBudgetProjectionWorkerId();
    expect(first).toMatch(/^budget-projection:/);
    expect(first).not.toBe(second);
    expect(() => createBudgetProjectionWorkerId(() => 'not-a-uuid')).toThrow(/canonical UUIDv4/);
  });

  it.each([
    [1, 1],
    [2, 2],
    [9, 256],
    [10, 300],
    [1_000, 300],
  ])('bounds retry attempt %s to %s seconds', (attempt, expected) => {
    expect(__budgetProjectionPostgresTesting.retryDelaySeconds(attempt)).toBe(expected);
  });

  it('rejects unsafe persisted failure summaries', () => {
    expect(() =>
      __budgetProjectionPostgresTesting.validateFailure({ code: 'bad', message: 'safe' }),
    ).toThrow(/uppercase/);
    expect(() =>
      __budgetProjectionPostgresTesting.validateFailure({
        code: 'FAILED',
        message: 'line\nbreak',
      }),
    ).toThrow(/safe bounded/);
  });

  it('aggregates bounded multi-builder projection and reconciliation outcomes', async () => {
    const builderB = '99999999-9999-4999-8999-999999999999';
    const eventB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const outboxB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const leases = new Map([
      [BUILDER_ID, projectionLease()],
      [
        builderB,
        projectionLease({
          builder_id: builderB,
          outbox_id: outboxB,
          event_id: eventB,
          payload: toolPayload({
            builder_id: builderB,
            event_id: eventB,
            customer_id: `${builderB}:customer_2`,
          }),
        }),
      ],
    ]);
    const listBuilderPage = vi.fn(async (after: string | null) =>
      after === null ? [BUILDER_ID, builderB] : [],
    );
    const store = mockStore({
      listBuilderPage,
      recoverExpiredLeases: vi.fn(async (builderId) => (builderId === BUILDER_ID ? 1 : 0)),
      claim: vi.fn(async (builderId) => [leases.get(builderId)!]),
      status: vi.fn(async (builderId) =>
        projectionStatus({
          projected_verified: 1,
          high_attempt_rows: builderId === builderB ? 1 : 0,
        }),
      ),
    });
    const seen = new Map<string, number>();
    const target: BudgetProjectionTarget = {
      insert: vi.fn(async () => undefined),
      inspect: vi.fn(async (_builderId, eventId) => {
        const calls = (seen.get(eventId) ?? 0) + 1;
        seen.set(eventId, calls);
        return calls === 1 ? missing : matched;
      }),
    };

    const result = await runBudgetCostEventProjection(
      {
        workerId: WORKER_ID,
        builderPageSize: 2,
        builderConcurrency: 2,
        eventConcurrency: 2,
      },
      { store, target },
    );
    expect(result).toMatchObject({
      scanned_builders: 2,
      errors: 0,
      recovered_leases: 1,
      claimed_events: 2,
      projected_events: 2,
      high_attempt_rows: 1,
    });
    expect(result.worker_incarnation).toMatch(/^[0-9a-f]{12}$/);
    expect(listBuilderPage).toHaveBeenNthCalledWith(1, null, 2);
    expect(listBuilderPage).toHaveBeenNthCalledWith(2, builderB, 2);
  });

  it('surfaces a reconciliation conflict while retaining the unverified billing alarm', async () => {
    const item: BudgetProjectionReconciliationItem = {
      builder_id: BUILDER_ID,
      outbox_id: OUTBOX_ID,
      event_id: EVENT_ID,
      payload_hash: PAYLOAD_HASH,
    };
    const store = mockStore({
      listBuilderPage: vi.fn(async (after) => (after === null ? [BUILDER_ID] : [])),
      listReconciliationItems: vi.fn(async (_builderId, after) => (after === null ? [item] : [])),
      status: vi.fn(async () => projectionStatus({ projected_unverified: 1, caught_up: false })),
    });

    const result = await runBudgetCostEventProjection(
      { workerId: WORKER_ID },
      { store, target: mockTarget([conflict]) },
    );

    expect(result).toMatchObject({
      scanned_builders: 1,
      reconciliation_scanned: 1,
      reconciliation_verified: 0,
      reconciliation_conflicts: 1,
      projected_unverified_rows: 1,
    });
    expect(store.markVerified).not.toHaveBeenCalled();
  });

  it('claims in startable waves so queued leases cannot age out before processing', async () => {
    const eventIds = [
      EVENT_ID,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ];
    let cursor = 0;
    let active = 0;
    let maximumActive = 0;
    const claim = vi.fn(async (_builderId: string, _workerId: string, limit: number) => {
      const selected = eventIds.slice(cursor, cursor + limit);
      cursor += selected.length;
      return selected.map((eventId, index) =>
        projectionLease({
          event_id: eventId,
          outbox_id: `${String(cursor - selected.length + index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
          payload: toolPayload({ event_id: eventId }),
        }),
      );
    });
    const store = mockStore({
      listBuilderPage: vi.fn(async (after) => (after === null ? [BUILDER_ID] : [])),
      claim,
    });
    const target: BudgetProjectionTarget = {
      inspect: vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return matched;
      }),
      insert: vi.fn(async () => undefined),
    };

    const result = await runBudgetCostEventProjection(
      { workerId: WORKER_ID, claimLimit: 3, eventConcurrency: 2 },
      { store, target },
    );

    expect(result.claimed_events).toBe(3);
    expect(result.already_present_events).toBe(3);
    expect(claim).toHaveBeenNthCalledWith(1, BUILDER_ID, WORKER_ID, 2);
    expect(claim).toHaveBeenNthCalledWith(2, BUILDER_ID, WORKER_ID, 1);
    expect(maximumActive).toBeLessThanOrEqual(2);
  });

  it('isolates a builder failure and detects all-builder or all-event systemic failure', async () => {
    const store = mockStore({
      listBuilderPage: vi.fn(async (after) => (after === null ? [BUILDER_ID] : [])),
      recoverExpiredLeases: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const result = await runBudgetCostEventProjection(
      { workerId: WORKER_ID },
      { store, target: mockTarget() },
    );
    expect(result).toMatchObject({ scanned_builders: 1, errors: 1 });
    expect(budgetProjectionRunFailedSystemically(result)).toBe(true);

    expect(
      budgetProjectionRunFailedSystemically({
        ...result,
        errors: 0,
        claimed_events: 2,
        retry_scheduled: 2,
      }),
    ).toBe(true);
    expect(
      budgetProjectionRunFailedSystemically({
        ...result,
        errors: 0,
        claimed_events: 2,
        lease_lost: 2,
      }),
    ).toBe(true);
  });

  it('rejects non-monotonic builder pages and unsafe concurrency options', async () => {
    const store = mockStore({
      listBuilderPage: vi.fn(async () => [BUILDER_ID, BUILDER_ID]),
    });
    await expect(
      runBudgetCostEventProjection({ workerId: WORKER_ID }, { store, target: mockTarget() }),
    ).rejects.toThrow(/strictly ordered/);
    await expect(
      runBudgetCostEventProjection(
        { workerId: WORKER_ID, eventConcurrency: 0 },
        { store: mockStore(), target: mockTarget() },
      ),
    ).rejects.toThrow(/eventConcurrency/);
    await expect(
      runBudgetCostEventProjection(
        { workerId: 'reused-worker' },
        { store: mockStore(), target: mockTarget() },
      ),
    ).rejects.toThrow(/incarnation identity/);
  });
});
