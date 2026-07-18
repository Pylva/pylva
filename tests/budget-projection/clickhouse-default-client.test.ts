import type { ClickHouseClient } from '@clickhouse/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYLOAD_HASH, toolPayload } from './fixtures.js';

const getReadyBudgetProjectionClickHouseClient = vi.fn();

const { createBudgetProjectionTarget } =
  await import('../../src/lib/budget-projection/clickhouse.js');

function client(): ClickHouseClient {
  return {
    insert: vi.fn(async () => undefined),
  } as unknown as ClickHouseClient;
}

describe('projection default dedicated ClickHouse client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears a rejected readiness promise so recovered attestation can retry', async () => {
    const transientFailure = new Error('temporary ClickHouse attestation failure');
    const recovered = client();
    getReadyBudgetProjectionClickHouseClient
      .mockRejectedValueOnce(transientFailure)
      .mockResolvedValueOnce(recovered);
    const target = createBudgetProjectionTarget(
      undefined,
      25_000,
      getReadyBudgetProjectionClickHouseClient,
    );

    await expect(target.insert(toolPayload(), PAYLOAD_HASH)).rejects.toBe(transientFailure);
    await expect(target.insert(toolPayload(), PAYLOAD_HASH)).resolves.toBeUndefined();
    expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(2);
  });

  it('delegates every concurrent insert to the one posture-cache owner', async () => {
    let release!: (value: ClickHouseClient) => void;
    const ready = new Promise<ClickHouseClient>((resolve) => {
      release = resolve;
    });
    const resolved = client();
    getReadyBudgetProjectionClickHouseClient.mockReturnValue(ready);
    const target = createBudgetProjectionTarget(
      undefined,
      25_000,
      getReadyBudgetProjectionClickHouseClient,
    );

    const inserts = Promise.all([
      target.insert(toolPayload(), PAYLOAD_HASH),
      target.insert(toolPayload(), PAYLOAD_HASH),
    ]);
    await vi.waitFor(() => expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalled());
    release(resolved);
    await expect(inserts).resolves.toEqual([undefined, undefined]);
    expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(2);
  });

  it('does not add an outer client cache that can extend attestation lifetime', async () => {
    const resolved = client();
    getReadyBudgetProjectionClickHouseClient.mockResolvedValue(resolved);
    const target = createBudgetProjectionTarget(
      undefined,
      25_000,
      getReadyBudgetProjectionClickHouseClient,
    );

    await target.insert(toolPayload(), PAYLOAD_HASH);
    await target.insert(toolPayload(), PAYLOAD_HASH);
    expect(getReadyBudgetProjectionClickHouseClient).toHaveBeenCalledTimes(2);
  });
});
