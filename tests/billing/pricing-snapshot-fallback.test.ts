// Regression: syncFromSnapshot() must NOT record a 'success' run when the
// snapshot yields zero valid entries.
//
// Trigger scenario:
//   1. LiteLLM upstream breaks → 3 consecutive 'aborted' rows in
//      pricing_sync_log → escalation fires → snapshot fallback is invoked
//      (?fallback=snapshot).
//   2. packages/shared/pricing-snapshot.json is empty (it is committed as
//      `[]` in this repo today) → applyEntries([]) touches nothing.
//   3. Pre-fix, the run was still logged as status='success', which resets
//      the consecutive-failure streak that currentAttemptNumber() counts —
//      the escalation alert never re-fires while llm_pricing silently
//      drifts further from live provider rates every day.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeSpy = vi.fn();
const transactionSpy = vi.fn();
const slackSpy = vi.fn();
let snapshotContent = '[]';

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock('../../src/lib/alerts/slack.js', () => ({
  postSlackAlert: (msg: string) => {
    slackSpy(msg);
    return Promise.resolve();
  },
}));

vi.mock('../../src/lib/external-egress.js', () => ({
  externalFetch: () => Promise.reject(new Error('no network in unit tests')),
}));

vi.mock('../../src/lib/db/client.js', () => ({
  db: {
    // currentAttemptNumber() reads pricing_sync_log; recordLog() inserts.
    execute: (...args: unknown[]) => {
      executeSpy(...args);
      return Promise.resolve([]);
    },
    // applyEntries() opens a transaction — it must NOT run for an empty snapshot.
    transaction: (cb: (tx: unknown) => Promise<void>) => {
      transactionSpy();
      return cb({ execute: () => Promise.resolve([]) });
    },
  },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: () => Promise.resolve(snapshotContent),
  },
}));

const { syncFromSnapshot } = await import('../../src/lib/pricing/litellm-sync.js');

describe('syncFromSnapshot — empty snapshot guard', () => {
  beforeEach(() => {
    executeSpy.mockClear();
    transactionSpy.mockClear();
    slackSpy.mockClear();
  });

  it('aborts (not success) on an empty snapshot and leaves llm_pricing untouched', async () => {
    snapshotContent = '[]';

    const result = await syncFromSnapshot();

    expect(result.status).toBe('aborted');
    expect(result.synced).toBe(0);
    expect(result.failure_reason).toContain('snapshot_empty');
    // llm_pricing untouched: applyEntries never opened a transaction.
    expect(transactionSpy).not.toHaveBeenCalled();
    // Loud failure: ops get a Slack alert instead of a silent fake success.
    expect(slackSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts when every snapshot entry is invalid', async () => {
    snapshotContent = JSON.stringify([
      {
        provider: 'openai',
        model: 'gpt-x',
        input_per_1m: -1,
        output_per_1m: 2,
      },
      { provider: 42, model: 'broken' },
    ]);

    const result = await syncFromSnapshot();

    expect(result.status).toBe('aborted');
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('alerts when the snapshot cannot be parsed', async () => {
    snapshotContent = 'not json';

    const result = await syncFromSnapshot();

    expect(result.status).toBe('aborted');
    expect(result.failure_reason).toBeTruthy();
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(slackSpy).toHaveBeenCalledTimes(1);
    expect(slackSpy.mock.calls[0]![0]).toContain('pricing snapshot fallback aborted');
  });

  it('still applies a populated snapshot and records success', async () => {
    snapshotContent = JSON.stringify([
      {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m: 2.5,
        output_per_1m: 10,
      },
    ]);

    const result = await syncFromSnapshot();

    expect(result.status).toBe('success');
    expect(result.synced).toBe(1);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(slackSpy).not.toHaveBeenCalled();
  });
});
