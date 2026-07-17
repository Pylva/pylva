import type { ClickHouseClient } from '@clickhouse/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_PROJECTION_CLICKHOUSE_ATTESTATION_TTL_MS } from '../../src/lib/budget-projection/clickhouse-config.js';
import { PAYLOAD_HASH, toolPayload } from './fixtures.js';

const getReadyBudgetProjectionClickHouseClient = vi.fn();

vi.mock('../../src/lib/budget-projection/clickhouse-posture.js', () => ({
  getReadyBudgetProjectionClickHouseClient,
}));

const { __budgetProjectionClickHouseTesting, createBudgetProjectionTarget } =
  await import('../../src/lib/budget-projection/clickhouse.js');

function client(): ClickHouseClient {
  return {
    insert: vi.fn(async () => undefined),
  } as unknown as ClickHouseClient;
}

describe('projection default dedicated ClickHouse client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __budgetProjectionClickHouseTesting.resetDefaultClient();
  });

  it('clears a rejected readiness promise so recovered attestation can retry', async () => {
    const transientFailure = new Error('temporary ClickHouse attestation failure');
    const recovered = client();
    getReadyBudgetProjectionClickHouseClient
      .mockRejectedValueOnce(transientFailure)
      .mockResolvedValueOnce(recovered);
    const target = createBudgetProjectionTarget();

    await expect(target.insert(toolPayload(), PAYLOAD_HASH)).rejects.toBe(transientFailure);
    await expect(target.insert(toolPayload(), PAYLOAD_HASH)).resolves.toBeUndefined();
    expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(2);
  });

  it('shares one successful posture initialization across concurrent inserts', async () => {
    let release!: (value: ClickHouseClient) => void;
    const ready = new Promise<ClickHouseClient>((resolve) => {
      release = resolve;
    });
    const resolved = client();
    getReadyBudgetProjectionClickHouseClient.mockReturnValue(ready);
    const target = createBudgetProjectionTarget();

    const inserts = Promise.all([
      target.insert(toolPayload(), PAYLOAD_HASH),
      target.insert(toolPayload(), PAYLOAD_HASH),
    ]);
    await vi.waitFor(() =>
      expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(1),
    );
    release(resolved);
    await expect(inserts).resolves.toEqual([undefined, undefined]);
    expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(1);
  });

  it('reattests a cached client after the bounded drift window', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const resolved = client();
    getReadyBudgetProjectionClickHouseClient.mockResolvedValue(resolved);
    const target = createBudgetProjectionTarget();

    await target.insert(toolPayload(), PAYLOAD_HASH);
    await target.insert(toolPayload(), PAYLOAD_HASH);
    expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(1);

    now += BUDGET_PROJECTION_CLICKHOUSE_ATTESTATION_TTL_MS + 1;
    await target.insert(toolPayload(), PAYLOAD_HASH);
    expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });
});
