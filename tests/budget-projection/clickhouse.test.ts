import { describe, expect, it, vi } from 'vitest';
import {
  __budgetProjectionClickHouseTesting,
  createBudgetProjectionTarget,
  type BudgetProjectionClickHouseClient,
} from '../../src/lib/budget-projection/clickhouse.js';
import { BUILDER_ID, EVENT_ID, PAYLOAD_HASH, toolPayload } from './fixtures.js';

function mockClient(rows: unknown[] = []) {
  return {
    insert: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ json: async () => rows })),
  } satisfies BudgetProjectionClickHouseClient;
}

describe('authoritative budget ClickHouse target', () => {
  it('uses synchronous one-event insertion into the idempotent physical table', async () => {
    const client = mockClient();
    const target = createBudgetProjectionTarget(client);
    await target.insert(toolPayload(), PAYLOAD_HASH);
    expect(client.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'budget_cost_events',
        format: 'JSONEachRow',
        clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
        values: [
          expect.objectContaining({
            event_id: EVENT_ID,
            builder_id: BUILDER_ID,
            payload_hash: PAYLOAD_HASH,
            cost_usd: '0.001234567890123456',
          }),
        ],
      }),
    );
  });

  it('reports a missing event from the physical and FINAL read models', async () => {
    const client = mockClient([
      { physical_rows: '0', hash_count: '0', hashes: [], logical_rows: '0', logical_hash: '' },
    ]);
    const target = createBudgetProjectionTarget(client, 1_000);
    await expect(target.inspect(BUILDER_ID, EVENT_ID, PAYLOAD_HASH)).resolves.toEqual({
      state: 'missing',
      physical_rows: 0,
      logical_rows: 0,
      hashes: [],
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('FROM budget_cost_events FINAL'),
        query_params: { builder_id: BUILDER_ID, event_id: EVENT_ID },
        query_id: expect.stringMatching(
          new RegExp(`^budget-projection-verify-${EVENT_ID}-[0-9a-f-]{36}$`),
        ),
        format: 'JSONEachRow',
      }),
    );
  });

  it('accepts multiple identical physical retries as one logical event', async () => {
    const client = mockClient([
      {
        physical_rows: '3',
        hash_count: '1',
        hashes: [PAYLOAD_HASH],
        logical_rows: '1',
        logical_hash: PAYLOAD_HASH,
      },
    ]);
    await expect(
      createBudgetProjectionTarget(client).inspect(BUILDER_ID, EVENT_ID, PAYLOAD_HASH),
    ).resolves.toEqual({
      state: 'matched',
      physical_rows: 3,
      logical_rows: 1,
      hashes: [PAYLOAD_HASH],
    });
  });

  it.each([
    {
      label: 'different physical hashes',
      row: {
        physical_rows: 2,
        hash_count: 2,
        hashes: [PAYLOAD_HASH, 'b'.repeat(64)],
        logical_rows: 1,
        logical_hash: PAYLOAD_HASH,
      },
    },
    {
      label: 'wrong logical hash',
      row: {
        physical_rows: 1,
        hash_count: 1,
        hashes: ['b'.repeat(64)],
        logical_rows: 1,
        logical_hash: 'b'.repeat(64),
      },
    },
    {
      label: 'multiple logical rows',
      row: {
        physical_rows: 2,
        hash_count: 1,
        hashes: [PAYLOAD_HASH],
        logical_rows: 2,
        logical_hash: PAYLOAD_HASH,
      },
    },
  ])('reports $label as a conflict', async ({ row }) => {
    const target = createBudgetProjectionTarget(mockClient([row]));
    await expect(target.inspect(BUILDER_ID, EVENT_ID, PAYLOAD_HASH)).resolves.toMatchObject({
      state: 'conflict',
    });
  });

  it.each([
    [[]],
    [[{}, {}]],
    [[{ physical_rows: 'NaN', hash_count: 0, hashes: [], logical_rows: 0 }]],
    [[{ physical_rows: 1, hash_count: 1, hashes: 'hash', logical_rows: 1 }]],
  ] as Array<[unknown[]]>)('fails closed on malformed inspection output %#', async (rows) => {
    await expect(
      createBudgetProjectionTarget(mockClient(rows)).inspect(BUILDER_ID, EVENT_ID, PAYLOAD_HASH),
    ).rejects.toThrow(/inspection/);
  });

  it.each([0, 99, 45_001, 1.5, Number.NaN])('rejects unsafe timeout %s', (timeoutMs) => {
    expect(() => createBudgetProjectionTarget(mockClient(), timeoutMs)).toThrow(/timeoutMs/);
  });

  it('exports the pure inspection parser for deterministic edge tests', () => {
    expect(
      __budgetProjectionClickHouseTesting.parseInspection(
        [
          {
            physical_rows: 1,
            hash_count: 1,
            hashes: [PAYLOAD_HASH],
            logical_rows: 1,
            logical_hash: PAYLOAD_HASH,
          },
        ],
        PAYLOAD_HASH,
      ),
    ).toMatchObject({ state: 'matched' });
  });
});
